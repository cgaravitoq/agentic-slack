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

const knipReport = v.object({
  issues: v.array(
    v.object({
      files: v.array(v.object({ name: v.string() })),
    }),
  ),
});

const runProductionAudit = async (): Promise<ReadonlySet<string>> => {
  const audit = Bun.spawn(
    [process.execPath, "run", "knip:production", "--reporter", "json"],
    { cwd: repoRoot, stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(audit.stdout).text(),
    new Response(audit.stderr).text(),
    audit.exited,
  ]);
  if (stdout.trim() === "") {
    throw new Error(`knip:production produced no report: ${stderr.trim()}`);
  }
  const { issues } = v.parse(knipReport, JSON.parse(stdout));
  return new Set(
    issues.flatMap((issue) => issue.files.map((file) => file.name)),
  );
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

test("reaches production only through the Worker entry and reports dead or test-only files", async () => {
  await writeFixtures();
  try {
    const unusedFiles = await runProductionAudit();
    expect(unusedFiles).not.toContain(workerEntry);
    expect(unusedFiles).not.toContain(workerOnlyImport);
    expect(unusedFiles).toContain(deadFile);
    expect(unusedFiles).toContain(testOnlyFile);
  } finally {
    await removeFixtures();
  }
});
