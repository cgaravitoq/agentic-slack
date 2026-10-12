import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { version } from "../package.json";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(tmpdir(), "agentic-slack-package-"));
const consumer = path.join(temporary, "consumer");
const instance = path.join(consumer, "instance");
await mkdir(consumer);

const run = async (args: string[], cwd: string): Promise<string> => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  console.log(
    `$ bun ${args.join(" ")} (cwd: ${cwd})\n${stdout}${stderr}exit: ${exitCode}`,
  );
  assert.equal(exitCode, 0);
  return stdout;
};

const tarball = path.join(temporary, "agentic-slack.tgz");
await run(["pm", "pack", "--filename", tarball], root);
await Bun.write(
  path.join(consumer, "package.json"),
  JSON.stringify({
    dependencies: { "agentic-slack": `file:${tarball}` },
    private: true,
    trustedDependencies: [],
    type: "module",
  }),
);
assert.deepEqual(await readdir(consumer), ["package.json"]);
await run(["install", "--production"], consumer);

const cli = (args: string[]): Promise<string> =>
  run(["x", "--no-install", "agentic-slack", ...args], consumer);

const help = await cli(["--help"]);
assert.match(help, /init <dir>/u);
assert.match(help, /build --dir <dir> --env <env>/u);
const installedVersion = await cli(["--version"]);
assert.equal(installedVersion.trim(), version);

const distConfig = (stdout: string): string => {
  const configPath = stdout.trim().split("\n").at(-1);
  assert.ok(configPath !== undefined);
  assert.ok(configPath.startsWith(path.join(instance, ".agentic-slack/")));
  return configPath;
};

const wrangler = v.object({
  ai: v.optional(v.object({ binding: v.string() })),
  d1_databases: v.array(
    v.object({
      database_id: v.string(),
      database_name: v.string(),
      migrations_dir: v.string(),
    }),
  ),
  durable_objects: v.object({
    bindings: v.array(v.object({ class_name: v.string() })),
  }),
  main: v.string(),
  migrations: v.array(v.object({ tag: v.string() })),
  name: v.string(),
  routes: v.array(
    v.object({ custom_domain: v.boolean(), pattern: v.string() }),
  ),
  services: v.optional(
    v.array(v.object({ binding: v.string(), service: v.string() })),
  ),
  vars: v.record(v.string(), v.string()),
});

const wranglerConfig = async (
  configPath: string,
): Promise<v.InferOutput<typeof wrangler>> =>
  v.parse(wrangler, await Bun.file(configPath).json());

await cli(["init", "instance"]);
const scaffoldedFiles = await readdir(instance);
assert.deepEqual(scaffoldedFiles.toSorted(), [
  ".gitignore",
  "agent.yaml",
  "package.json",
]);
assert.equal(
  await Bun.file(path.join(instance, ".gitignore")).text(),
  "node_modules/\n.agentic-slack/\n",
);
const scaffolded = v.parse(
  v.object({ dependencies: v.record(v.string(), v.string()) }),
  await Bun.file(path.join(instance, "package.json")).json(),
);
assert.equal(scaffolded.dependencies["agentic-slack"], version);

const template = await wranglerConfig(
  distConfig(await cli(["build", "--dir", "instance", "--env", "staging"])),
);
assert.equal(template.name, "slack-agent-staging");
assert.equal(template.ai?.binding, "AI");
assert.deepEqual(template.services, []);
assert.equal(template.vars.SLACK_TEAM_ID, "T00000000");
assert.equal(template.d1_databases[0].database_name, "slack-agent-staging");
assert.equal(template.routes[0].pattern, "slack-agent-staging.example.com");

const externalName = "Packed Instance Agent";
const externalSkillDescription = "Packed refunds skill description.";

await mkdir(path.join(instance, "skills/refunds"), { recursive: true });
await writeFile(
  path.join(instance, "skills/refunds/SKILL.md"),
  `---
name: refunds
description: ${externalSkillDescription}
---

Confirm the order ID and the reason for the refund.
`,
);
await writeFile(
  path.join(instance, "agent.yaml"),
  `agent:
  name: ${externalName}
  description: An external operator configuration.
  ownerInstructions: Answer with the external configuration.
  model: broker/gpt-6-luna
  retention:
    channelDays: 3
    privateDays: 2
  skills:
    - skills/refunds
secrets:
  - SLACK_BOT_TOKEN
  - SLACK_SIGNING_SECRET
environments:
  staging:
    worker: package-fixture-staging
    domain: package-fixture-staging.example.com
    vars:
      SLACK_TEAM_ID: T0000000001
      SLACK_APP_ID: A0000000001
    d1:
      name: package-fixture-staging
      id: 33333333-3333-3333-3333-333333333333
    broker:
      service: fixture-broker
      entrypoint: OrbCompletion
`,
);

const configPath = distConfig(
  await cli(["build", "--dir", "instance", "--env", "staging"]),
);
const generatedFiles = await readdir(path.join(instance, ".agentic-slack"));
assert.deepEqual(generatedFiles.toSorted(), [
  "agent.config.ts",
  "staging",
  "wrangler.jsonc",
]);
const config = await wranglerConfig(configPath);

assert.equal(config.name, "package-fixture-staging");
assert.equal(config.services?.[0]?.binding, "MODEL_BROKER");
assert.equal(config.services?.[0]?.service, "fixture-broker");
assert.equal(config.ai, undefined);
assert.equal(config.d1_databases[0].database_name, "package-fixture-staging");
assert.equal(
  config.d1_databases[0].database_id,
  "33333333-3333-3333-3333-333333333333",
);
assert.equal(config.vars.SLACK_APP_ID, "A0000000001");
assert.equal(config.routes[0].pattern, "package-fixture-staging.example.com");
assert.equal(config.migrations[0].tag, "flue-class-FlueSlackAgentAgent");
assert.equal(
  config.durable_objects.bindings[0].class_name,
  "FlueSlackAgentAgent",
);
assert.ok(
  await Bun.file(
    path.resolve(
      path.dirname(configPath),
      config.d1_databases[0].migrations_dir,
      "0001_seen_events.sql",
    ),
  ).exists(),
);
const bundle = await Bun.file(
  path.join(path.dirname(configPath), config.main),
).text();
assert.ok(bundle.includes(externalName));
assert.ok(bundle.includes(externalSkillDescription));
assert.ok(!bundle.includes("Slack Agent"));
assert.ok(
  bundle.includes(
    '__flueBindAgentModule(SlackAgent, { identity: "SlackAgent" })',
  ),
);
assert.ok(bundle.includes("export { FlueSlackAgentAgent,"));
const installedAppFiles = await readdir(
  path.join(consumer, "node_modules/agentic-slack/apps/slack-agent"),
);
assert.ok(!installedAppFiles.includes("dist"));
assert.ok(!installedAppFiles.includes("package.json"));
console.log(`Package check passed: ${configPath}`);
