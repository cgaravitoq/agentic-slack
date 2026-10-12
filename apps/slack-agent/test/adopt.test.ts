import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
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

const cli = path.resolve(import.meta.dirname, "../../../bin/agentic-slack.ts");

const agentYaml = `agent:
  name: Package Fixture
  description: An adopted instance.
  ownerInstructions: Answer with the adopted configuration.
secrets:
  - SLACK_BOT_TOKEN
environments:
  staging:
    worker: package-fixture-staging
    domain: package-fixture-staging.example.com
    vars:
      SLACK_TEAM_ID: T0000000001
    d1:
      name: package-fixture-staging
`;

const d1Id = "33333333-3333-3333-3333-333333333333";
const appId = "A0000000001";
const eventsUrl =
  "https://package-fixture-staging.example.com/channels/slack/events";
const botScopes = [
  "app_mentions:read",
  "assistant:write",
  "channels:manage",
  "channels:read",
  "chat:write",
  "groups:read",
  "groups:write",
  "im:history",
  "mpim:read",
  "mpim:write",
  "reactions:write",
];

interface LiveManifest {
  _metadata: { major_version: number; minor_version: number };
  display_information: {
    background_color: string;
    description: string;
    name: string;
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[]; request_url: string };
    interactivity: { is_enabled: boolean; request_url?: string };
    org_deploy_enabled: boolean;
  };
}

const liveManifest = (overrides: Partial<LiveManifest> = {}): LiveManifest => ({
  _metadata: { major_version: 1, minor_version: 1 },
  display_information: {
    background_color: "#123456",
    description: "An adopted instance.",
    name: "Package Fixture",
  },
  oauth_config: { scopes: { bot: botScopes.toReversed() } },
  settings: {
    event_subscriptions: {
      bot_events: [
        "message.im",
        "app_mention",
        "member_joined_channel",
        "assistant_thread_started",
      ],
      request_url: eventsUrl,
    },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
  },
  ...overrides,
});

const preload = `import { readFileSync, writeFileSync } from "node:fs";

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  writeFileSync(
    process.env.STUB_SLACK_CALL,
    JSON.stringify({
      authorization: request.headers.get("authorization"),
      body: await request.text(),
      url: request.url,
    }),
  );
  return Response.json({
    manifest: JSON.parse(readFileSync(process.env.STUB_SLACK_MANIFEST, "utf8")),
    ok: true,
  });
};
`;

const wranglerStub = (
  d1List: readonly { name: string; uuid: string }[],
  deploymentsExit: number,
): string =>
  [
    "#!/bin/sh",
    'if [ "$1" = "d1" ] && [ "$2" = "list" ]; then',
    `  echo '${JSON.stringify(d1List)}'`,
    "  exit 0",
    "fi",
    'if [ "$1" = "deployments" ] && [ "$2" = "list" ]; then',
    deploymentsExit === 0
      ? "  echo '[]'"
      : "  echo 'This Worker does not exist on your account.' >&2",
    `  exit ${deploymentsExit}`,
    "fi",
    'echo "unexpected wrangler $*" >&2',
    "exit 1",
    "",
  ].join("\n");

const databases = [{ name: "package-fixture-staging", uuid: d1Id }];

interface AdoptRun {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runAdopt = async (
  directory: string,
  options: {
    d1List?: readonly { name: string; uuid: string }[];
    deploymentsExit?: number;
    manifest?: LiveManifest;
  } = {},
): Promise<AdoptRun> => {
  const stubs = path.join(directory, "stubs");
  await mkdir(stubs, { recursive: true });
  const wrangler = path.join(stubs, "wrangler");
  await writeFile(
    wrangler,
    wranglerStub(options.d1List ?? databases, options.deploymentsExit ?? 0),
  );
  await chmod(wrangler, 0o755);
  const slackCall = path.join(directory, "slack-call.json");
  const slackManifest = path.join(directory, "slack-manifest.json");
  await writeFile(
    slackManifest,
    JSON.stringify(options.manifest ?? liveManifest()),
  );
  const preloadFile = path.join(directory, "slack-stub.ts");
  await writeFile(preloadFile, preload);
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preloadFile,
      cli,
      "adopt",
      "--dir",
      directory,
      "--env",
      "staging",
      "--d1-id",
      d1Id,
      "--app-id",
      appId,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${stubs}:${process.env.PATH ?? ""}`,
        SLACK_CONFIG_TOKEN: "xoxe-test-config-token",
        STUB_SLACK_CALL: slackCall,
        STUB_SLACK_MANIFEST: slackManifest,
      },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 30_000,
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
};

const prepared = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentic-slack-adopt-"));
  await writeFile(path.join(directory, "agent.yaml"), agentYaml);
  return directory;
};

const lockFile = async (directory: string): Promise<boolean> => {
  const files = await readdir(directory);
  return files.includes(lockFileName);
};

describe("adopt", () => {
  test("takes over the D1 database, Worker and Slack app", async () => {
    const directory = await prepared();

    const run = await runAdopt(directory);

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(`Adopted staging in ${directory}`);
    expect(run.exitCode).toBe(0);
    const lock = await readLock(directory);
    const instance = parseInstance(agentYaml);
    expect(lock.environments.staging).toEqual({
      d1: { id: d1Id, name: "package-fixture-staging" },
      domain: "package-fixture-staging.example.com",
      slack: {
        appId,
        manifestSha256: manifestSha256(
          generateSlackManifest(
            defineAgentConfig({ ...instance.agent, skills: undefined }),
            "https://package-fixture-staging.example.com",
          ),
        ),
      },
      worker: "package-fixture-staging",
    });
    const call = v.parse(
      v.object({
        authorization: v.string(),
        body: v.string(),
        url: v.string(),
      }),
      await Bun.file(path.join(directory, "slack-call.json")).json(),
    );
    expect(call.url).toBe("https://slack.com/api/apps.manifest.export");
    expect(call.authorization).toBe("Bearer xoxe-test-config-token");
    expect(call.body).toBe(`app_id=${appId}`);
  });

  test("refuses a D1 database the id names differently", async () => {
    const directory = await prepared();

    const run = await runAdopt(directory, {
      d1List: [{ name: "someone-elses-database", uuid: d1Id }],
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      `D1 database ${d1Id} is named someone-elses-database, but agent.yaml names it package-fixture-staging`,
    );
    expect(await lockFile(directory)).toBe(false);
  });

  test("refuses an id the account does not have", async () => {
    const directory = await prepared();

    const run = await runAdopt(directory, { d1List: [] });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`Cloudflare has no D1 database ${d1Id}`);
    expect(await lockFile(directory)).toBe(false);
  });

  test("refuses a Worker the account does not have", async () => {
    const directory = await prepared();

    const run = await runAdopt(directory, { deploymentsExit: 1 });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "Cloudflare has no Worker package-fixture-staging",
    );
    expect(await lockFile(directory)).toBe(false);
  });

  test("refuses a Slack app whose manifest differs", async () => {
    const directory = await prepared();

    const run = await runAdopt(directory, {
      manifest: liveManifest({
        oauth_config: {
          scopes: {
            bot: [
              ...botScopes.filter((scope) => scope !== "reactions:write"),
              "chat:write.customize",
            ],
          },
        },
        settings: {
          event_subscriptions: {
            bot_events: ["app_mention"],
            request_url: "https://old.example.com/channels/slack/events",
          },
          interactivity: {
            is_enabled: true,
            request_url: "https://old.example.com/channels/slack/interactions",
          },
          org_deploy_enabled: false,
        },
      }),
    });

    expect(run.exitCode).toBe(1);
    for (const difference of [
      "bot scopes: missing reactions:write",
      "bot scopes: unexpected chat:write.customize",
      "bot events: missing assistant_thread_started, member_joined_channel, message.im",
      `events request URL: the app has https://old.example.com/channels/slack/events, the manifest asks for ${eventsUrl}`,
      "interactivity: the app has it enabled, the manifest asks for it disabled",
    ]) {
      expect(run.stderr).toContain(difference);
    }
    expect(await lockFile(directory)).toBe(false);
  });

  test("refuses an enabled interactivity request URL that differs", async () => {
    const directory = await prepared();
    await writeFile(
      path.join(directory, "agent.yaml"),
      agentYaml.replace(
        "  ownerInstructions: Answer with the adopted configuration.\n",
        [
          "  ownerInstructions: Answer with the adopted configuration.",
          "  mcpServers:",
          "    - name: tracker",
          "      url: https://mcp.example.com",
          "      requireApproval:",
          "        - create_issue",
          "",
        ].join("\n"),
      ),
    );

    const run = await runAdopt(directory, {
      manifest: liveManifest({
        settings: {
          ...liveManifest().settings,
          interactivity: {
            is_enabled: true,
            request_url: "https://old.example.com/channels/slack/interactions",
          },
        },
      }),
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "interactivity request URL: the app has https://old.example.com/channels/slack/interactions, the manifest asks for https://package-fixture-staging.example.com/channels/slack/interactions",
    );
    expect(await lockFile(directory)).toBe(false);
  });
});
