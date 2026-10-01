import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "../../..");
const bundle = path.join(
  repoRoot,
  "apps/slack-agent/dist/agentic_slack/index.js",
);
const externalName = "External Receipt Agent";
const externalSkillDescription = "External receipt skill description.";

const externalSkill = `---
name: refunds
description: ${externalSkillDescription}
---

Confirm the order ID and the reason for the refund.
`;

const externalConfig = `import refunds from "./skills/refunds/SKILL.md";

export default {
  description: "An external operator configuration.",
  model: "cloudflare/@cf/zai-org/glm-4.7-flash",
  name: "${externalName}",
  ownerInstructions: "Answer with the external configuration.",
  retention: { channelDays: 3, privateDays: 2 },
  skills: [refunds],
  suggestedPrompts: [],
};
`;

const build = async (agentConfig?: string): Promise<string> => {
  const env = { ...process.env };
  if (agentConfig === undefined) {
    delete env.AGENT_CONFIG;
  } else {
    env.AGENT_CONFIG = agentConfig;
  }
  const child = Bun.spawn([process.execPath, "run", "build"], {
    cwd: repoRoot,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`build failed:\n${stdout}\n${stderr}`);
  }
  return await Bun.file(bundle).text();
};

test("builds an agent config and its skills from outside the repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentic-slack-config-"));
  try {
    await mkdir(path.join(directory, "skills/refunds"), { recursive: true });
    await writeFile(
      path.join(directory, "skills/refunds/SKILL.md"),
      externalSkill,
    );
    await writeFile(path.join(directory, "agent.config.ts"), externalConfig);

    const bundled = await build(path.join(directory, "agent.config.ts"));

    expect(bundled).toContain(externalName);
    expect(bundled).toContain(externalSkillDescription);
    expect(bundled).not.toContain("Slack Agent");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);

test("defaults to the in-repo agent config when AGENT_CONFIG is unset", async () => {
  const bundled = await build();

  expect(bundled).toContain("Slack Agent");
  expect(bundled).not.toContain(externalName);
}, 30_000);
