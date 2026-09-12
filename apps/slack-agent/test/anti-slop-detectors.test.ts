import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

const repoRoot = path.join(import.meta.dirname, "../../..");

const fixtures = {
  "bun-mock.ts": `import { mock } from "bun:test";

export const install = async (): Promise<void> => {
  await mock.module("./subject", () => ({ value: 1 }));
};
`,
  "jest-mock.ts": `import { jest } from "@jest/globals";

export const install = (): void => {
  jest.mock("./subject");
};
`,
  "justified-assertion.ts": `export const readCount = (payload: string): number => {
  // SAFETY: our own serializer always writes a numeric count.
  const parsed = JSON.parse(payload) as { count: number };
  return parsed.count;
};
`,
  "unjustified-assertion.ts": `export const readCount = (payload: string): number => {
  const parsed = JSON.parse(payload) as { count: number };
  return parsed.count;
};
`,
};

const oxlintReport = v.object({
  diagnostics: v.array(
    v.object({
      code: v.string(),
      filename: v.string(),
    }),
  ),
});

const lintFixtures = async (): Promise<Map<string, string[]>> => {
  const directory = await mkdtemp(
    path.join(import.meta.dirname, ".anti-slop-"),
  );
  try {
    await Promise.all(
      Object.entries(fixtures).map(([name, source]) =>
        writeFile(path.join(directory, name), source),
      ),
    );
    const oxlint = Bun.spawn(
      [
        process.execPath,
        "x",
        "oxlint",
        "--config",
        "oxlint.config.ts",
        "--format",
        "json",
        directory,
      ],
      { cwd: repoRoot, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(oxlint.stdout).text(),
      new Response(oxlint.stderr).text(),
      oxlint.exited,
    ]);
    if (!stdout.trimStart().startsWith("{")) {
      throw new Error(
        `oxlint produced no report: ${stdout.trim()}${stderr.trim()}`,
      );
    }
    const { diagnostics } = v.parse(oxlintReport, JSON.parse(stdout));
    const byFile = new Map<string, string[]>();
    for (const diagnostic of diagnostics) {
      const name = path.basename(diagnostic.filename);
      byFile.set(name, [...(byFile.get(name) ?? []), diagnostic.code]);
    }
    return byFile;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const diagnostics = await lintFixtures();

describe("anti-slop detectors", () => {
  test("reports an unjustified assertion and jest module mocking", () => {
    expect(diagnostics.get("unjustified-assertion.ts")).toContain(
      "anti-slop(require-safety-comment-for-type-assertion)",
    );
    expect(diagnostics.get("jest-mock.ts")).toContain(
      "anti-slop(no-module-mocking)",
    );
  });

  test("accepts a SAFETY-documented assertion", () => {
    expect(diagnostics.get("justified-assertion.ts")).toBeUndefined();
  });

  test("misses Bun's mock.module, the mocking API this repo relies on", () => {
    expect(diagnostics.get("bun-mock.ts")).toBeUndefined();
  });
});
