import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

const repoRoot = path.join(import.meta.dirname, "../../..");
const workerEntry = "apps/slack-agent/src/index.ts";
const workerOnlyImport = "apps/slack-agent/agent.config.ts";
const fixtureDir = "apps/slack-agent/src/production-audit-fixture";
const deadFile = `${fixtureDir}/dead.ts`;
const testOnlyFile = `${fixtureDir}/test-only.ts`;
const fixtureTest = "apps/slack-agent/test/production-audit-fixture.test.ts";

// Flue and the Workers runtime consume one export in each of these modules, so
// Knip exempts them with a `@public` tag on that single symbol. A planted
// unused export in the same file must still be reported.
const runtimeExportFiles = [
  "apps/slack-agent/flue.config.ts",
  "apps/slack-agent/src/agent.ts",
  workerEntry,
] as const;
const plantedExport = "productionAuditPlantedExport";

const knipReport = v.object({
  issues: v.array(
    v.object({
      exports: v.array(v.object({ name: v.string() })),
      file: v.string(),
      files: v.array(v.object({ name: v.string() })),
      types: v.array(v.object({ name: v.string() })),
    }),
  ),
});

interface AuditReport {
  unusedFiles: ReadonlySet<string>;
  reports: (file: string, symbol: string) => boolean;
}

const runAudit = async (
  script: "knip" | "knip:production",
): Promise<AuditReport> => {
  const audit = Bun.spawn(
    [process.execPath, "run", script, "--reporter", "json"],
    { cwd: repoRoot, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(audit.stdout).text(),
    new Response(audit.stderr).text(),
    audit.exited,
  ]);
  if (stdout.trim() === "") {
    throw new Error(`${script} produced no report: ${stderr.trim()}`);
  }
  const { issues } = v.parse(knipReport, JSON.parse(stdout));
  const symbols = new Map<string, Set<string>>();
  for (const issue of issues) {
    const names = symbols.get(issue.file) ?? new Set<string>();
    for (const symbol of [...issue.exports, ...issue.types]) {
      names.add(symbol.name);
    }
    symbols.set(issue.file, names);
  }
  return {
    reports: (file, symbol) => symbols.get(file)?.has(symbol) ?? false,
    unusedFiles: new Set(
      issues.flatMap((issue) => issue.files.map((file) => file.name)),
    ),
  };
};

const writeFixtures = async () => {
  await mkdir(path.join(repoRoot, fixtureDir), { recursive: true });
  await writeFile(
    path.join(repoRoot, deadFile),
    "export const productionAuditDead = true;\n",
  );
  await writeFile(
    path.join(repoRoot, testOnlyFile),
    "export const productionAuditTestOnly = true;\n",
  );
  await writeFile(
    path.join(repoRoot, fixtureTest),
    'import { productionAuditTestOnly } from "../src/production-audit-fixture/test-only.ts";\n\nexport const reached = productionAuditTestOnly;\n',
  );
};

const removeFixtures = () =>
  Promise.all([
    rm(path.join(repoRoot, fixtureDir), { force: true, recursive: true }),
    rm(path.join(repoRoot, fixtureTest), { force: true }),
  ]);

// Read every source before writing any of them, so a failed read leaves the
// working tree clean and the caller's `finally` can restore every path.
const readSources = async (): Promise<Map<string, string>> =>
  new Map(
    await Promise.all(
      runtimeExportFiles.map(async (file): Promise<[string, string]> => {
        const target = path.join(repoRoot, file);
        return [target, await Bun.file(target).text()];
      }),
    ),
  );

// Every write settles before this resolves, so a write that rejects cannot
// still land after the caller's `finally` restored the sources.
const plantExports = async (
  originals: ReadonlyMap<string, string>,
): Promise<void> => {
  const settled = await Promise.allSettled(
    [...originals].map(([file, source]) =>
      writeFile(file, `${source}\nexport const ${plantedExport} = true;\n`),
    ),
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason;
  }
};

const restoreFiles = (originals: ReadonlyMap<string, string>) =>
  Promise.all([...originals].map(([file, source]) => writeFile(file, source)));

test("reaches production only through the Worker entry and reports dead or test-only files", async () => {
  await writeFixtures();
  try {
    const { unusedFiles } = await runAudit("knip:production");
    expect(unusedFiles).not.toContain(workerEntry);
    expect(unusedFiles).not.toContain(workerOnlyImport);
    expect(unusedFiles).toContain(deadFile);
    expect(unusedFiles).toContain(testOnlyFile);
  } finally {
    await removeFixtures();
  }
});

test("reports a planted export in the modules whose runtime export is exempt", async () => {
  const originals = await readSources();
  try {
    await plantExports(originals);
    const all = await runAudit("knip");
    for (const file of runtimeExportFiles) {
      expect(all.reports(file, plantedExport)).toBe(true);
    }
    expect(all.reports("apps/slack-agent/src/agent.ts", "cloudflare")).toBe(
      false,
    );
    expect(all.reports("apps/slack-agent/flue.config.ts", "default")).toBe(
      false,
    );

    const production = await runAudit("knip:production");
    expect(production.reports(workerEntry, plantedExport)).toBe(true);
    expect(production.reports(workerEntry, "default")).toBe(false);
  } finally {
    await restoreFiles(originals);
  }
}, 30_000);
