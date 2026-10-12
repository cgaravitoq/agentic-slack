import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { defineAgentConfig } from "../../../packages/core/src/config.ts";
import { parseInstance } from "../../../packages/core/src/instance.ts";
import {
  lockFileName,
  manifestSha256,
  readLock,
} from "../../../packages/core/src/lock.ts";
import { generateSlackManifest } from "../../../packages/core/src/manifest.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repositoryRoot, "bin/agentic-slack.ts");
// Every test here spawns the CLI, which builds and deploys through stubbed
// wrangler; a slow runner needs more than the five-second default.
setDefaultTimeout(60_000);

const d1Id = "33333333-3333-3333-3333-333333333333";
const appId = "A0000000PROV";
const botToken = "xoxb-provision-fixture-bot";
const configToken = "xoxe-provision-fixture-config";
const progressBearer = "provision-fixture-progress";
const signingSecret = "provision-fixture-signing";
const domain = "provision-fixture-staging.example.com";

const agentYaml = `agent:
  name: Provision Fixture
  description: A provisioned instance.
  ownerInstructions: Answer with the provisioned configuration.
secrets:
  - SLACK_BOT_TOKEN
  - SLACK_SIGNING_SECRET
  - PROGRESS_BEARER
environments:
  staging:
    worker: provision-fixture-staging
    domain: ${domain}
    vars:
      SLACK_TEAM_ID: T0000000001
    d1:
      name: provision-fixture-staging
  prod:
    worker: provision-fixture
    domain: provision-fixture.example.com
    vars:
      SLACK_TEAM_ID: T0000000002
      SLACK_APP_ID: A0000000002
    d1:
      name: provision-fixture
`;

const stagingSlack = { appId, manifestSha256: "1".repeat(64) };

const prodEntry = {
  d1: { id: "22222222-2222-2222-2222-222222222222", name: "instance" },
  domain: "provision-fixture.example.com",
  slack: { appId: "A0000000002", manifestSha256: "2".repeat(64) },
  worker: "provision-fixture",
};

const stagingEntry = {
  d1: { id: "11111111-1111-1111-1111-111111111111", name: "adopted-staging" },
  domain,
  slack: stagingSlack,
  worker: "provision-fixture-staging",
};

const lockSource = `${JSON.stringify(
  { environments: { prod: prodEntry, staging: stagingEntry }, version: 1 },
  null,
  2,
)}\n`;

const lockWithoutSlackApp = `${JSON.stringify(
  {
    environments: {
      staging: {
        d1: {
          id: "11111111-1111-1111-1111-111111111111",
          name: "adopted-staging",
        },
        domain,
        worker: "provision-fixture-staging",
      },
    },
    version: 1,
  },
  null,
  2,
)}\n`;

const wranglerStub = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.STUB_WRANGLER_LOG, args.join(" ") + "\\n");
const statePath = process.env.STUB_WRANGLER_STATE;
const seededSecrets = () => {
  const names = (process.env.STUB_WRANGLER_SECRETS ?? "")
    .split(",")
    .filter((name) => name !== "");
  return names.length === 0 ? {} : { "provision-fixture-staging": names };
};
const existing = existsSync(statePath);
const state = existing
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {
      databases: [],
      deleted: [],
      deploys: [],
      put: {},
      secrets: seededSecrets(),
      workers: (process.env.STUB_WRANGLER_WORKERS ?? "")
        .split(",")
        .filter((name) => name !== ""),
    };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const named = (flag) => args[args.indexOf(flag) + 1];
const [group, command] = args;

if (group === "d1" && command === "list") {
  console.log(
    JSON.stringify(
      state.databases.map((database) => ({
        name: database.name,
        uuid: database.uuid,
      })),
    ),
  );
  process.exit(0);
}
if (group === "d1" && command === "create") {
  if (process.env.STUB_WRANGLER_FAIL_CREATE === "1") {
    fail("d1 create failed");
  }
  state.databases.push({ name: args[2], uuid: process.env.STUB_WRANGLER_D1_ID });
  save();
  console.log("Created " + args[2]);
  process.exit(0);
}
if (group === "d1" && command === "migrations") {
  if (process.env.STUB_WRANGLER_FAIL_MIGRATIONS === "1") {
    fail("migrations failed");
  }
  console.log("No migrations to apply!");
  process.exit(0);
}
if (group === "d1" && command === "delete") {
  state.databases = state.databases.filter((database) => database.name !== args[2]);
  state.deleted.push("d1 " + args[2]);
  save();
  console.log("Deleted " + args[2]);
  process.exit(0);
}
if (group === "secret" && command === "list") {
  const worker = named("--name");
  console.log(
    JSON.stringify(
      (state.secrets[worker] ?? []).map((name) => ({
        name,
        type: "secret_text",
      })),
    ),
  );
  process.exit(0);
}
if (group === "secret" && command === "put") {
  const worker = named("--name");
  const value = (await Bun.stdin.text()).trim();
  state.secrets[worker] = [...new Set([...(state.secrets[worker] ?? []), args[2]])];
  state.put[worker + " " + args[2]] = value;
  save();
  console.log("Success! Uploaded secret " + args[2]);
  process.exit(0);
}
if (group === "deployments" && command === "list") {
  const worker = named("--name");
  if (process.env.STUB_WRANGLER_FAIL_DEPLOYMENTS === "1") {
    fail("Authentication error [code: 10000]");
  }
  if (!state.workers.includes(worker)) {
    fail("Worker " + worker + " not found");
  }
  console.log(JSON.stringify([{ id: "deployment", name: worker }]));
  process.exit(0);
}
if (group === "deploy") {
  if (process.env.STUB_WRANGLER_FAIL_DEPLOY === "1") {
    fail("deploy failed");
  }
  const configPath = named("--config");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  state.deploys.push({ config: configPath, name: config.name, vars: config.vars ?? {} });
  state.workers = [...new Set([...state.workers, config.name])];
  save();
  console.log("Deployed " + config.name);
  process.exit(0);
}
if (group === "delete") {
  state.deleted.push("worker " + args[1]);
  state.workers = state.workers.filter((worker) => worker !== args[1]);
  save();
  console.log("Successfully deleted " + args[1]);
  process.exit(0);
}
fail("unexpected wrangler " + args.join(" "));
`;

const preload = `import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";

if (process.env.STUB_TTY === "1") {
  const stdin = new Readable({ read() {} });
  const typed = process.env.STUB_STDIN_INPUT ?? "";
  for (let at = 0; at < typed.length; at += 8) {
    stdin.push(typed.slice(at, at + 8));
  }
  stdin.push(null);
  Object.defineProperty(stdin, "isTTY", { value: true });
  stdin.setRawMode = () => {};
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
}

let slackCalls = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  appendFileSync(process.env.STUB_FETCH_LOG, url + "\\n");
  if (url.startsWith("https://slack.com/api/")) {
    const method = url.slice("https://slack.com/api/".length);
    slackCalls += 1;
    appendFileSync(
      process.env.STUB_SLACK_LOG,
      JSON.stringify({
        method,
        params: Object.fromEntries(
          new URLSearchParams(String(init?.body ?? "")),
        ),
        token: String(init?.headers?.authorization ?? ""),
      }) + "\\n",
    );
    if (process.env.STUB_SLACK_RATELIMIT === "1" && slackCalls === 1) {
      return Response.json(
        { error: "ratelimited", ok: false },
        { status: 429 },
      );
    }
    if (method === "apps.manifest.create") {
      return Response.json({
        app_id: process.env.STUB_SLACK_APP_ID,
        credentials: { signing_secret: process.env.STUB_SLACK_SIGNING_SECRET },
        oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=stub",
        ok: true,
      });
    }
    if (method === "apps.manifest.update") {
      return Response.json({
        app_id: process.env.STUB_SLACK_APP_ID,
        ok: true,
        permissions_updated: false,
      });
    }
    if (method === "apps.manifest.delete") {
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown_method", ok: false });
  }
  if (process.env.STUB_HEALTH === "missing") {
    return Response.json(
      { missing: ["SLACK_BOT_TOKEN", "DB"], status: "not_ready" },
      { status: 503 },
    );
  }
  return Response.json({ status: "ready" });
};
`;

interface Deploy {
  name: string;
  vars: Record<string, string>;
}

interface SlackCall {
  method: string;
  params: Record<string, string>;
  token: string;
}

interface StubState {
  databases: readonly { name: string; uuid: string }[];
  deleted: readonly string[];
  deploys: readonly Deploy[];
  put: Record<string, string>;
  secrets: Record<string, readonly string[]>;
  workers: readonly string[];
}

interface CliRun {
  calls: readonly string[];
  deploys: readonly Deploy[];
  exitCode: number;
  fetchLog: readonly string[];
  slack: readonly SlackCall[];
  state: StubState;
  stderr: string;
  stdout: string;
}

const prepared = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentic-slack-up-"));
  await writeFile(path.join(directory, "agent.yaml"), agentYaml);
  await mkdir(path.join(directory, "node_modules"), { recursive: true });
  await symlink(
    repositoryRoot,
    path.join(directory, "node_modules/agentic-slack"),
  );
  const stubs = path.join(directory, "stubs");
  await mkdir(stubs, { recursive: true });
  const wrangler = path.join(stubs, "wrangler");
  await writeFile(wrangler, wranglerStub);
  await chmod(wrangler, 0o755);
  await writeFile(path.join(directory, "preload.ts"), preload);
  await writeFile(path.join(directory, "wrangler.log"), "");
  await writeFile(path.join(directory, "fetch.log"), "");
  await writeFile(path.join(directory, "slack.log"), "");
  return directory;
};

const runCli = async (
  directory: string,
  args: readonly string[],
  options: {
    input?: string;
    lock?: string;
    environment?: Record<string, string>;
  } = {},
): Promise<CliRun> => {
  if (options.lock !== undefined) {
    await writeFile(path.join(directory, lockFileName), options.lock);
  }
  await writeFile(path.join(directory, "wrangler.log"), "");
  await writeFile(path.join(directory, "fetch.log"), "");
  await writeFile(path.join(directory, "slack.log"), "");
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(directory, "preload.ts"),
      cli,
      ...args,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        CI: "true",
        PATH: `${path.join(directory, "stubs")}:${process.env.PATH ?? ""}`,
        PROGRESS_BEARER: "",
        SLACK_BOT_TOKEN: "",
        SLACK_CONFIG_TOKEN: "",
        SLACK_SIGNING_SECRET: "",
        STUB_FETCH_LOG: path.join(directory, "fetch.log"),
        STUB_SLACK_APP_ID: appId,
        STUB_SLACK_LOG: path.join(directory, "slack.log"),
        STUB_SLACK_SIGNING_SECRET: signingSecret,
        STUB_STDIN_INPUT: options.input ?? "",
        STUB_WRANGLER_D1_ID: d1Id,
        STUB_WRANGLER_LOG: path.join(directory, "wrangler.log"),
        STUB_WRANGLER_STATE: path.join(directory, "wrangler-state.json"),
        ...options.environment,
      },
      stderr: "pipe",
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: "pipe",
      timeout: 120_000,
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lines = async (name: string): Promise<readonly string[]> => {
    const contents = await Bun.file(path.join(directory, name)).text();
    return contents.split("\n").filter((line) => line !== "");
  };
  const stateFile = path.join(directory, "wrangler-state.json");
  const state = (await Bun.file(stateFile).exists())
    ? v.parse(
        v.object({
          databases: v.array(v.object({ name: v.string(), uuid: v.string() })),
          deleted: v.array(v.string()),
          deploys: v.array(
            v.object({
              config: v.string(),
              name: v.string(),
              vars: v.record(v.string(), v.string()),
            }),
          ),
          put: v.record(v.string(), v.string()),
          secrets: v.record(v.string(), v.array(v.string())),
          workers: v.array(v.string()),
        }),
        await Bun.file(stateFile).json(),
      )
    : {
        databases: [],
        deleted: [],
        deploys: [],
        put: {},
        secrets: {},
        workers: [],
      };
  const slackLines = await lines("slack.log");
  return {
    calls: await lines("wrangler.log"),
    deploys: state.deploys,
    exitCode,
    fetchLog: await lines("fetch.log"),
    slack: slackLines.map((line) =>
      v.parse(
        v.object({
          method: v.string(),
          params: v.record(v.string(), v.string()),
          token: v.string(),
        }),
        JSON.parse(line),
      ),
    ),
    state,
    stderr,
    stdout,
  };
};

const upArguments = (directory: string): readonly string[] => [
  "up",
  "--dir",
  directory,
  "--env",
  "staging",
];

const downArguments = (directory: string): readonly string[] => [
  "down",
  "--dir",
  directory,
  "--env",
  "staging",
];

const manifestSchema = v.object({
  settings: v.object({
    event_subscriptions: v.object({ request_url: v.string() }),
  }),
});

const configured = {
  PROGRESS_BEARER: progressBearer,
  SLACK_BOT_TOKEN: botToken,
  SLACK_CONFIG_TOKEN: configToken,
};

describe("up", () => {
  test("creates the app, redeploys its id and sets the Slack secrets", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory), {
      environment: configured,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`D1 provision-fixture-staging (${d1Id})`);
    expect(run.stdout).toContain(
      `Deployed provision-fixture-staging to https://${domain}`,
    );
    expect(run.stdout).toContain(`Created Slack app ${appId}`);
    expect(run.stdout).toContain(
      `https://api.slack.com/apps/${appId}/install-on-team`,
    );
    expect(run.stdout).toContain(`https://${domain}/health is ready`);
    expect(run.stdout).not.toContain(botToken);
    expect(run.stdout).not.toContain(signingSecret);
    expect(run.stderr).not.toContain(configToken);

    expect(run.slack.map((call) => call.method)).toEqual([
      "apps.manifest.create",
    ]);
    const [created] = run.slack;
    expect(created.token).toBe(`Bearer ${configToken}`);
    expect(created.params.manifest).toBeDefined();
    const manifest = v.parse(
      manifestSchema,
      JSON.parse(created.params.manifest),
    );
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `https://${domain}/channels/slack/events`,
    );

    expect(run.calls.some((call) => call.startsWith("d1 create"))).toBe(true);
    expect(
      run.calls.some((call) => call.startsWith("d1 migrations apply DB")),
    ).toBe(true);
    expect(run.deploys.map((deploy) => deploy.name)).toEqual([
      "provision-fixture-staging",
      "provision-fixture-staging",
    ]);
    expect(run.deploys[0].vars.SLACK_APP_ID).toBeUndefined();
    expect(run.deploys[1].vars.SLACK_APP_ID).toBe(appId);
    expect(run.deploys[1].vars.SLACK_TEAM_ID).toBe("T0000000001");
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": progressBearer,
      "provision-fixture-staging SLACK_BOT_TOKEN": botToken,
      "provision-fixture-staging SLACK_SIGNING_SECRET": signingSecret,
    });
    expect(run.fetchLog).toEqual([
      "https://slack.com/api/apps.manifest.create",
      `https://${domain}/health`,
    ]);
    expect(await readLock(directory)).toEqual({
      environments: {
        staging: {
          d1: { id: d1Id, name: "provision-fixture-staging" },
          domain,
          slack: {
            appId,
            manifestSha256: manifestSha256(created.params.manifest),
          },
          worker: "provision-fixture-staging",
        },
      },
      version: 1,
    });
  });

  test("reruns without creating the D1 again, calling Slack or rewriting secrets", async () => {
    const directory = await prepared();
    await runCli(directory, upArguments(directory), {
      environment: configured,
    });

    const run = await runCli(directory, upArguments(directory), {
      environment: configured,
    });

    expect(run.exitCode).toBe(0);
    expect(run.calls.some((call) => call.startsWith("d1 create"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("secret put"))).toBe(false);
    expect(run.slack).toEqual([]);
    expect(run.stderr).not.toContain("SLACK_BOT_TOKEN: ");
    expect(run.stdout).toContain(
      `Slack app ${appId} matches the generated manifest`,
    );
    expect(run.stdout).not.toContain("install-on-team");
    expect(run.stdout).toContain("Worker secrets: kept PROGRESS_BEARER");
    expect(run.deploys.at(-1)?.vars.SLACK_APP_ID).toBe(appId);
    expect(run.state.databases).toHaveLength(1);
  });

  test("updates the app when the generated manifest changed", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory), {
      environment: {
        ...configured,
        STUB_WRANGLER_SECRETS: "SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET",
      },
      lock: lockSource,
    });

    expect(run.exitCode).toBe(0);
    expect(run.slack.map((call) => call.method)).toEqual([
      "apps.manifest.update",
    ]);
    expect(run.slack[0].params.app_id).toBe(appId);
    expect(run.slack[0].token).toBe(`Bearer ${configToken}`);
    expect(run.stdout).toContain(`Updated Slack app ${appId}`);
    expect(run.stdout).not.toContain("install-on-team");
    expect(run.deploys).toHaveLength(1);
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": progressBearer,
    });
    const lock = await readLock(directory);
    expect(lock.environments.staging?.slack?.manifestSha256).toBe(
      manifestSha256(run.slack[0].params.manifest),
    );
  });

  test("skips an app whose manifest matches without asking for a token", async () => {
    const directory = await prepared();
    const instance = parseInstance(agentYaml);
    const manifest = generateSlackManifest(
      defineAgentConfig({ ...instance.agent, skills: undefined }),
      `https://${domain}`,
    );
    const skipped = {
      ...stagingEntry,
      slack: { appId, manifestSha256: manifestSha256(manifest) },
    };
    const lock = `${JSON.stringify(
      { environments: { staging: skipped }, version: 1 },
      null,
      2,
    )}\n`;

    const run = await runCli(directory, upArguments(directory), {
      environment: {
        PROGRESS_BEARER: progressBearer,
        STUB_WRANGLER_SECRETS: "SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET",
      },
      lock,
    });

    expect(run.exitCode).toBe(0);
    expect(run.slack).toEqual([]);
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": progressBearer,
    });
    expect(run.stderr).not.toContain("configuration token");
    expect(run.stdout).toContain(
      `Slack app ${appId} matches the generated manifest`,
    );
    expect(await readLock(directory)).toEqual({
      environments: { staging: skipped },
      version: 1,
    });
  });

  test("replaces a signing secret the Worker kept from an earlier app", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory), {
      environment: {
        ...configured,
        STUB_WRANGLER_SECRETS: "SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET",
      },
    });

    expect(run.exitCode).toBe(0);
    expect(run.slack.map((call) => call.method)).toEqual([
      "apps.manifest.create",
    ]);
    expect(
      run.state.put["provision-fixture-staging SLACK_SIGNING_SECRET"],
    ).toBe(signingSecret);
  });

  test("retries a Slack call Slack is rate limiting", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory), {
      environment: { ...configured, STUB_SLACK_RATELIMIT: "1" },
    });

    expect(run.exitCode).toBe(0);
    expect(run.slack.map((call) => call.method)).toEqual([
      "apps.manifest.create",
      "apps.manifest.create",
    ]);
    expect(run.stdout).toContain("Slack is rate limiting apps.manifest.create");
    const lock = await readLock(directory);
    expect(lock.environments.staging?.slack?.appId).toBe(appId);
  });

  test("prompts on a tty for the missing secrets and never prints them", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory), {
      environment: { SLACK_CONFIG_TOKEN: configToken, STUB_TTY: "1" },
      input: "prompted-progress\nprompted-bot-token\n",
    });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("PROGRESS_BEARER: ");
    expect(run.stderr).toContain("SLACK_BOT_TOKEN: ");
    expect(run.stderr).not.toContain("SLACK_SIGNING_SECRET: ");
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": "prompted-progress",
      "provision-fixture-staging SLACK_BOT_TOKEN": "prompted-bot-token",
      "provision-fixture-staging SLACK_SIGNING_SECRET": signingSecret,
    });
    expect(`${run.stdout}${run.stderr}`).not.toContain("prompted-progress");
    expect(`${run.stdout}${run.stderr}`).not.toContain("prompted-bot-token");
  });

  test("stores pasted secrets without their bracketed paste markers", async () => {
    const directory = await prepared();
    const pasted = "\u001B[200~";
    const ended = "\u001B[201~";

    const run = await runCli(directory, upArguments(directory), {
      environment: { SLACK_CONFIG_TOKEN: configToken, STUB_TTY: "1" },
      input: `${pasted}pasted-progress${ended}\n${pasted}pasted-bot-token${ended}\n`,
    });

    expect(run.exitCode).toBe(0);
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": "pasted-progress",
      "provision-fixture-staging SLACK_BOT_TOKEN": "pasted-bot-token",
      "provision-fixture-staging SLACK_SIGNING_SECRET": signingSecret,
    });
  });

  test("erases the last pasted character on a backspace after a paste", async () => {
    const directory = await prepared();
    const pasted = "\u001B[200~";
    const ended = "\u001B[201~";

    const run = await runCli(directory, upArguments(directory), {
      environment: { SLACK_CONFIG_TOKEN: configToken, STUB_TTY: "1" },
      input: `${pasted}pasted-progressX${ended}\u007F\n${pasted}pasted-bot-token${ended}\n`,
    });

    expect(run.exitCode).toBe(0);
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": "pasted-progress",
      "provision-fixture-staging SLACK_BOT_TOKEN": "pasted-bot-token",
      "provision-fixture-staging SLACK_SIGNING_SECRET": signingSecret,
    });
  });

  test("resumes after a failed deploy without creating a second D1", async () => {
    const directory = await prepared();

    const failed = await runCli(directory, upArguments(directory), {
      environment: { ...configured, STUB_WRANGLER_FAIL_DEPLOY: "1" },
    });

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("wrangler deploy --config");
    expect(failed.slack).toEqual([]);
    expect(await readLock(directory)).toEqual({
      environments: {
        staging: { d1: { id: d1Id, name: "provision-fixture-staging" } },
      },
      version: 1,
    });

    const resumed = await runCli(directory, upArguments(directory), {
      environment: configured,
    });

    expect(resumed.exitCode).toBe(0);
    expect(resumed.calls.some((call) => call.startsWith("d1 create"))).toBe(
      false,
    );
    expect(resumed.deploys).toHaveLength(2);
    expect(resumed.state.databases).toHaveLength(1);
  });

  test("keeps an existing secret unless --rotate names it", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      [...upArguments(directory), "--rotate", "PROGRESS_BEARER"],
      {
        environment: {
          ...configured,
          STUB_WRANGLER_SECRETS: "PROGRESS_BEARER",
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.calls).toContain(
      "secret put PROGRESS_BEARER --name provision-fixture-staging",
    );
    expect(run.state.put).toEqual({
      "provision-fixture-staging PROGRESS_BEARER": progressBearer,
      "provision-fixture-staging SLACK_BOT_TOKEN": botToken,
      "provision-fixture-staging SLACK_SIGNING_SECRET": signingSecret,
    });
    expect(run.stdout).toContain("Worker secrets: set PROGRESS_BEARER");
  });

  test("reports the missing bindings when the Worker is not ready", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory), {
      environment: { ...configured, STUB_HEALTH: "missing" },
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      `https://${domain}/health is not ready: missing SLACK_BOT_TOKEN, DB`,
    );
  });

  test("refuses a secret the environment does not carry", async () => {
    const directory = await prepared();

    const run = await runCli(directory, upArguments(directory));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "PROGRESS_BEARER is not a Worker secret and the environment does not set it",
    );
    expect(run.slack).toEqual([]);
    expect(run.calls.some((call) => call.startsWith("deploy"))).toBe(true);
  });

  test("refuses --rotate for a secret agent.yaml does not declare", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      [...upArguments(directory), "--rotate", "NOT_DECLARED"],
      { environment: configured },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "--rotate names secrets agent.yaml does not declare: NOT_DECLARED",
    );
    expect(run.calls).toEqual([]);
  });
});

describe("down", () => {
  test("aborts on a confirmation that does not match, deleting nothing", async () => {
    const directory = await prepared();

    const run = await runCli(directory, downArguments(directory), {
      input: "provision-fixture/staging\n",
      lock: lockSource,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "Nothing deleted: expected the exact text Provision Fixture/staging",
    );
    expect(run.stdout).toContain("Worker provision-fixture-staging");
    expect(run.stdout).toContain(
      "D1 adopted-staging (11111111-1111-1111-1111-111111111111)",
    );
    expect(run.stdout).toContain(`Custom domain https://${domain}`);
    expect(run.stdout).toContain(`Slack app ${appId}`);
    expect(run.calls).toEqual([]);
    expect(run.slack).toEqual([]);
    expect(await readLock(directory)).toEqual({
      environments: { prod: prodEntry, staging: stagingEntry },
      version: 1,
    });
  });

  test("deletes the locked Worker, Slack app and D1 and keeps the other entries", async () => {
    const directory = await prepared();

    const run = await runCli(directory, downArguments(directory), {
      environment: {
        SLACK_CONFIG_TOKEN: configToken,
        STUB_WRANGLER_WORKERS: "provision-fixture-staging",
      },
      input: "Provision Fixture/staging\n",
      lock: lockSource,
    });

    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([
      "deployments list --name provision-fixture-staging --json",
      "delete provision-fixture-staging --force",
      "d1 delete adopted-staging --skip-confirmation",
    ]);
    expect(run.slack.map((call) => call.method)).toEqual([
      "apps.manifest.delete",
    ]);
    expect(run.slack[0].params.app_id).toBe(appId);
    expect(run.slack[0].token).toBe(`Bearer ${configToken}`);
    expect(run.stdout).toContain(`Deleted Slack app ${appId}`);
    expect(run.stderr).not.toContain(configToken);
    const lock = await readLock(directory);
    expect(Object.keys(lock.environments)).toEqual(["prod"]);
    expect(lock.environments.prod).toEqual(prodEntry);
  });

  test("continues when the Worker is already gone and still deletes the D1", async () => {
    const directory = await prepared();

    const run = await runCli(directory, downArguments(directory), {
      environment: { SLACK_CONFIG_TOKEN: configToken },
      input: "Provision Fixture/staging\n",
      lock: lockSource,
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      "Worker provision-fixture-staging is already gone",
    );
    expect(run.calls).toEqual([
      "deployments list --name provision-fixture-staging --json",
      "d1 delete adopted-staging --skip-confirmation",
    ]);
    expect(run.slack.map((call) => call.method)).toEqual([
      "apps.manifest.delete",
    ]);
    expect(await readLock(directory)).toEqual({
      environments: { prod: prodEntry },
      version: 1,
    });
  });

  test("keeps everything when wrangler cannot tell whether the Worker exists", async () => {
    const directory = await prepared();

    const run = await runCli(directory, downArguments(directory), {
      environment: {
        SLACK_CONFIG_TOKEN: configToken,
        STUB_WRANGLER_FAIL_DEPLOYMENTS: "1",
        STUB_WRANGLER_WORKERS: "provision-fixture-staging",
      },
      input: "Provision Fixture/staging\n",
      lock: lockSource,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("Authentication error");
    expect(run.calls).toEqual([
      "deployments list --name provision-fixture-staging --json",
    ]);
    expect(run.slack).toEqual([]);
    const lock = await readLock(directory);
    expect(Object.keys(lock.environments)).toEqual(["prod", "staging"]);
  });

  test("deletes the D1 of an environment whose deploy never happened", async () => {
    const directory = await prepared();
    const failed = await runCli(directory, upArguments(directory), {
      environment: { ...configured, STUB_WRANGLER_FAIL_DEPLOY: "1" },
    });
    expect(failed.exitCode).toBe(1);

    const run = await runCli(directory, downArguments(directory), {
      input: "Provision Fixture/staging\n",
    });

    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([
      "d1 delete provision-fixture-staging --skip-confirmation",
    ]);
    expect(run.slack).toEqual([]);
    expect(run.stdout).not.toContain("Worker");
    expect(await readLock(directory)).toEqual({
      environments: {},
      version: 1,
    });
  });

  test("asks Slack for nothing when the lock records no app", async () => {
    const directory = await prepared();

    const run = await runCli(directory, downArguments(directory), {
      environment: { STUB_WRANGLER_WORKERS: "provision-fixture-staging" },
      input: "Provision Fixture/staging\n",
      lock: lockWithoutSlackApp,
    });

    expect(run.exitCode).toBe(0);
    expect(run.slack).toEqual([]);
    expect(run.stderr).not.toContain("configuration token");
    expect(run.stdout).not.toContain("Slack app");
    expect(run.calls).toEqual([
      "deployments list --name provision-fixture-staging --json",
      "delete provision-fixture-staging --force",
      "d1 delete adopted-staging --skip-confirmation",
    ]);
  });

  test("refuses an environment the lock does not hold", async () => {
    const directory = await prepared();

    const run = await runCli(directory, downArguments(directory), {
      input: "Provision Fixture/staging\n",
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      `${lockFileName} has no staging environment: nothing to delete`,
    );
    expect(run.calls).toEqual([]);
    expect(run.slack).toEqual([]);
  });
});
