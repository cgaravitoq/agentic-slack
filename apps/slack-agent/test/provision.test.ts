import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { lockFileName, readLock } from "../../../packages/core/src/lock.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const cli = path.join(repositoryRoot, "bin/agentic-slack.ts");
// Every test here spawns the CLI, which builds and deploys through stubbed
// wrangler; a slow runner needs more than the five-second default.
setDefaultTimeout(60_000);

const d1Id = "33333333-3333-3333-3333-333333333333";
const botToken = "xoxb-provision-fixture-bot";
const signingSecret = "provision-fixture-signing";

const agentYaml = `agent:
  name: Provision Fixture
  description: A provisioned instance.
  ownerInstructions: Answer with the provisioned configuration.
secrets:
  - SLACK_BOT_TOKEN
  - SLACK_SIGNING_SECRET
environments:
  staging:
    worker: provision-fixture-staging
    domain: provision-fixture-staging.example.com
    vars:
      SLACK_TEAM_ID: T0000000001
      SLACK_APP_ID: A0000000001
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

const stagingLockEntry = {
  d1: { id: "11111111-1111-1111-1111-111111111111", name: "adopted-staging" },
  worker: "provision-fixture-staging",
};

const lockSource = `${JSON.stringify(
  {
    environments: {
      prod: {
        d1: { id: "22222222-2222-2222-2222-222222222222", name: "instance" },
        slack: { appId: "A0000000002", manifestSha256: "2".repeat(64) },
        worker: "provision-fixture",
      },
      staging: stagingLockEntry,
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
const existing = existsSync(statePath);
const state = existing
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {
      databases: [],
      deleted: [],
      deployed: [],
      put: {},
      secrets: Object.fromEntries(
        (process.env.STUB_WRANGLER_SECRETS ?? "")
          .split(",")
          .filter((name) => name !== "")
          .map((name) => ["provision-fixture-staging", [name]]),
      ),
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
if (group === "deploy") {
  if (process.env.STUB_WRANGLER_FAIL_DEPLOY === "1") {
    fail("deploy failed");
  }
  state.deployed.push(named("--config"));
  save();
  console.log("Deployed");
  process.exit(0);
}
if (group === "delete") {
  state.deleted.push("worker " + args[1]);
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
  stdin.push(process.env.STUB_STDIN_INPUT ?? "");
  stdin.push(null);
  Object.defineProperty(stdin, "isTTY", { value: true });
  stdin.setRawMode = () => {};
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
}

globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  appendFileSync(process.env.STUB_FETCH_LOG, url + "\\n");
  if (process.env.STUB_HEALTH === "missing") {
    return Response.json(
      { missing: ["SLACK_BOT_TOKEN", "DB"], status: "not_ready" },
      { status: 503 },
    );
  }
  return Response.json({ status: "ready" });
};
`;

interface StubState {
  databases: readonly { name: string; uuid: string }[];
  deleted: readonly string[];
  deployed: readonly string[];
  put: Record<string, string>;
  secrets: Record<string, readonly string[]>;
}

interface CliRun {
  calls: readonly string[];
  exitCode: number;
  fetchLog: readonly string[];
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
        SLACK_BOT_TOKEN: "",
        SLACK_SIGNING_SECRET: "",
        STUB_FETCH_LOG: path.join(directory, "fetch.log"),
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
  return {
    calls: await lines("wrangler.log"),
    exitCode,
    fetchLog: await lines("fetch.log"),
    state: (await Bun.file(stateFile).exists())
      ? v.parse(
          v.object({
            databases: v.array(
              v.object({ name: v.string(), uuid: v.string() }),
            ),
            deleted: v.array(v.string()),
            deployed: v.array(v.string()),
            put: v.record(v.string(), v.string()),
            secrets: v.record(v.string(), v.array(v.string())),
          }),
          await Bun.file(stateFile).json(),
        )
      : { databases: [], deleted: [], deployed: [], put: {}, secrets: {} },
    stderr,
    stdout,
  };
};

const secrets = {
  SLACK_BOT_TOKEN: botToken,
  SLACK_SIGNING_SECRET: signingSecret,
};

describe("up", () => {
  test("creates the D1, migrates, deploys and pushes the declared secrets", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      ["up", "--dir", directory, "--env", "staging"],
      {
        environment: secrets,
      },
    );

    expect(run.stderr).not.toContain(botToken);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`D1 provision-fixture-staging (${d1Id})`);
    expect(run.stdout).toContain("Deployed provision-fixture-staging");
    expect(run.stdout).toContain("Slack app: none recorded");
    expect(run.stdout).toContain(
      "https://provision-fixture-staging.example.com/health is ready",
    );
    expect(run.stdout).not.toContain(botToken);
    expect(run.stdout).not.toContain(signingSecret);
    expect(run.calls).toContain("d1 create provision-fixture-staging");
    expect(
      run.calls.some((call) =>
        call.startsWith("d1 migrations apply DB --config"),
      ),
    ).toBe(true);
    expect(run.calls.some((call) => call.startsWith("deploy --config"))).toBe(
      true,
    );
    expect(run.state.put).toEqual({
      "provision-fixture-staging SLACK_BOT_TOKEN": botToken,
      "provision-fixture-staging SLACK_SIGNING_SECRET": signingSecret,
    });
    expect(run.fetchLog).toEqual([
      "https://provision-fixture-staging.example.com/health",
    ]);
    expect(await readLock(directory)).toEqual({
      environments: {
        staging: {
          d1: { id: d1Id, name: "provision-fixture-staging" },
          worker: "provision-fixture-staging",
        },
      },
      version: 1,
    });
  });

  test("reruns without creating the D1 again or rewriting its secrets", async () => {
    const directory = await prepared();
    await runCli(directory, ["up", "--dir", directory, "--env", "staging"], {
      environment: secrets,
    });

    const run = await runCli(
      directory,
      ["up", "--dir", directory, "--env", "staging"],
      { environment: secrets },
    );

    expect(run.exitCode).toBe(0);
    expect(run.calls.some((call) => call.startsWith("d1 create"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("secret put"))).toBe(false);
    expect(run.stdout).toContain(
      "Worker secrets: kept SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET",
    );
    expect(run.state.databases).toHaveLength(1);
  });

  test("resumes after a failed deploy without creating a second D1", async () => {
    const directory = await prepared();

    const failed = await runCli(
      directory,
      ["up", "--dir", directory, "--env", "staging"],
      { environment: { ...secrets, STUB_WRANGLER_FAIL_DEPLOY: "1" } },
    );

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("wrangler deploy --config");
    expect(await readLock(directory)).toEqual({
      environments: {
        staging: {
          d1: { id: d1Id, name: "provision-fixture-staging" },
          worker: "provision-fixture-staging",
        },
      },
      version: 1,
    });

    const resumed = await runCli(
      directory,
      ["up", "--dir", directory, "--env", "staging"],
      { environment: secrets },
    );

    expect(resumed.exitCode).toBe(0);
    expect(resumed.calls.some((call) => call.startsWith("d1 create"))).toBe(
      false,
    );
    expect(resumed.calls.some((call) => call.startsWith("deploy"))).toBe(true);
    expect(resumed.state.databases).toHaveLength(1);
  });

  test("keeps an existing secret unless --rotate names it", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      [
        "up",
        "--dir",
        directory,
        "--env",
        "staging",
        "--rotate",
        "SLACK_BOT_TOKEN",
      ],
      {
        environment: {
          ...secrets,
          STUB_WRANGLER_SECRETS: "SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET",
        },
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.calls).toContain(
      "secret put SLACK_BOT_TOKEN --name provision-fixture-staging",
    );
    expect(run.calls).not.toContain(
      "secret put SLACK_SIGNING_SECRET --name provision-fixture-staging",
    );
    expect(run.state.put).toEqual({
      "provision-fixture-staging SLACK_BOT_TOKEN": botToken,
    });
    expect(run.stdout).toContain(
      "Worker secrets: set SLACK_BOT_TOKEN; kept SLACK_SIGNING_SECRET",
    );
  });

  test("prompts on a tty and never prints the value", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      ["up", "--dir", directory, "--env", "staging"],
      {
        environment: { STUB_TTY: "1" },
        input: "prompted-bot-token\nprompted-signing-secret\n",
      },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("SLACK_BOT_TOKEN: ");
    expect(run.stderr).toContain("SLACK_SIGNING_SECRET: ");
    expect(run.state.put).toEqual({
      "provision-fixture-staging SLACK_BOT_TOKEN": "prompted-bot-token",
      "provision-fixture-staging SLACK_SIGNING_SECRET":
        "prompted-signing-secret",
    });
    expect(`${run.stdout}${run.stderr}`).not.toContain("prompted-bot-token");
    expect(`${run.stdout}${run.stderr}`).not.toContain(
      "prompted-signing-secret",
    );
  });

  test("reports the missing bindings when the Worker is not ready", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      ["up", "--dir", directory, "--env", "staging"],
      { environment: { ...secrets, STUB_HEALTH: "missing" } },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "https://provision-fixture-staging.example.com/health is not ready: missing SLACK_BOT_TOKEN, DB",
    );
  });

  test("refuses a secret the environment does not carry", async () => {
    const directory = await prepared();

    const run = await runCli(directory, [
      "up",
      "--dir",
      directory,
      "--env",
      "staging",
    ]);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "SLACK_BOT_TOKEN is not a Worker secret and the environment does not set it",
    );
    expect(run.calls.some((call) => call.startsWith("deploy"))).toBe(true);
  });

  test("refuses --rotate for a secret agent.yaml does not declare", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      [
        "up",
        "--dir",
        directory,
        "--env",
        "staging",
        "--rotate",
        "NOT_DECLARED",
      ],
      { environment: secrets },
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

    const run = await runCli(
      directory,
      ["down", "--dir", directory, "--env", "staging"],
      { input: "provision-fixture/staging\n", lock: lockSource },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "Nothing deleted: expected the exact text Provision Fixture/staging",
    );
    expect(run.stdout).toContain("Worker provision-fixture-staging");
    expect(run.stdout).toContain(
      "D1 adopted-staging (11111111-1111-1111-1111-111111111111)",
    );
    expect(run.calls).toEqual([]);
    expect(await readLock(directory)).toEqual({
      environments: {
        prod: {
          d1: { id: "22222222-2222-2222-2222-222222222222", name: "instance" },
          slack: { appId: "A0000000002", manifestSha256: "2".repeat(64) },
          worker: "provision-fixture",
        },
        staging: stagingLockEntry,
      },
      version: 1,
    });
  });

  test("deletes the locked Worker and D1 and keeps the other entries", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      ["down", "--dir", directory, "--env", "staging"],
      { input: "Provision Fixture/staging\n", lock: lockSource },
    );

    expect(run.exitCode).toBe(0);
    expect(run.calls).toEqual([
      "delete provision-fixture-staging --force",
      "d1 delete adopted-staging --skip-confirmation",
    ]);
    expect(run.stdout).toContain("Slack app: none recorded");
    const lock = await readLock(directory);
    expect(Object.keys(lock.environments)).toEqual(["prod"]);
    expect(lock.environments.prod).toEqual({
      d1: { id: "22222222-2222-2222-2222-222222222222", name: "instance" },
      slack: { appId: "A0000000002", manifestSha256: "2".repeat(64) },
      worker: "provision-fixture",
    });
  });

  test("refuses an environment the lock does not hold", async () => {
    const directory = await prepared();

    const run = await runCli(
      directory,
      ["down", "--dir", directory, "--env", "staging"],
      { input: "Provision Fixture/staging\n" },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      `${lockFileName} has no staging environment: nothing to delete`,
    );
    expect(run.calls).toEqual([]);
  });
});
