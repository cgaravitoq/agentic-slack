import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { version } from "../package.json";

const root = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(tmpdir(), "agentic-slack-package-"));
const consumer = path.join(temporary, "consumer");
const fixture = path.join(consumer, "instance");
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
assert.match(
  await run(["x", "--no-install", "agentic-slack", "--help"], consumer),
  /build --dir <dir> --env <env>/u,
);
const installedVersion = await run(
  ["x", "--no-install", "agentic-slack", "--version"],
  consumer,
);
assert.equal(installedVersion.trim(), version);

await mkdir(fixture);
await Bun.write(
  path.join(fixture, "agent.config.ts"),
  `import { defineAgentConfig } from "agentic-slack";

export default defineAgentConfig({
  description: "An external operator configuration.",
  model: "broker/gpt-6-luna",
  name: "Packed External Agent",
  ownerInstructions: "Answer with the external configuration.",
  read: {},
  retention: { channelDays: 15, privateDays: 7 },
  suggestedPrompts: [],
});
`,
);
await Bun.write(
  path.join(fixture, "wrangler.jsonc"),
  JSON.stringify({
    compatibility_date: "2026-08-13",
    compatibility_flags: ["nodejs_compat"],
    env: {
      staging: {
        d1_databases: [
          {
            binding: "DB",
            migrations_dir:
              "../node_modules/agentic-slack/apps/slack-agent/migrations",
          },
        ],
        name: "package-fixture-staging",
        preview_urls: false,
        services: [
          {
            binding: "MODEL_BROKER",
            entrypoint: "Completion",
            service: "fixture-broker",
          },
        ],
        workers_dev: false,
      },
    },
    migrations: [
      {
        new_sqlite_classes: ["FlueSlackAgentAgent"],
        tag: "flue-class-FlueSlackAgentAgent",
      },
    ],
    name: "package-fixture",
    preview_urls: false,
    workers_dev: false,
  }),
);

const stdout = await run(
  [
    "x",
    "--no-install",
    "agentic-slack",
    "build",
    "--dir",
    fixture,
    "--env",
    "staging",
  ],
  consumer,
);
const configPath = stdout.trim().split("\n").at(-1);
assert.ok(configPath !== undefined);
assert.ok(configPath.startsWith(path.join(fixture, ".agentic-slack/staging/")));
const config = v.parse(
  v.object({
    d1_databases: v.array(v.object({ migrations_dir: v.string() })),
    durable_objects: v.object({
      bindings: v.array(v.object({ class_name: v.string() })),
    }),
    main: v.string(),
    name: v.string(),
    services: v.array(v.object({ binding: v.string() })),
  }),
  await Bun.file(configPath).json(),
);
assert.equal(config.name, "package-fixture-staging");
assert.equal(config.services[0].binding, "MODEL_BROKER");
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
assert.ok(bundle.includes("Packed External Agent"));
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
