import { describe, expect, test } from "bun:test";
import { defineTool } from "@flue/runtime/tool";
import * as v from "valibot";

import {
  CHANNEL_RETENTION_DAYS,
  claimAndRun,
  CLOUDFLARE_TRACING_CONTENT,
  composeInstructions,
  composeTools,
  CORE_INSTRUCTIONS,
  CORE_REPLY_TOOL_NAME,
  createReplyTool,
  defineAgentConfig,
  expireLatest,
  generateSlackManifest,
  missingReadiness,
  MODEL,
  PRIVATE_RETENTION_DAYS,
  replaceRetention,
} from "@agentic-slack/core";

interface TestRuntimeContext {
  bindings: {
    pluginSecret: string;
    addonRoute: string;
  };
}

function terminalTool() {
  return defineTool({
    name: CORE_REPLY_TOOL_NAME,
    description: "Reply.",
    async run() {
      return { output: "posted", terminate: true };
    },
  });
}

function createTestPlugin(factoryCalls: string[], toolCalls: string[]) {
  return {
    id: "test-search",
    kind: "plugin" as const,
    instructions: ["Use test search for exact lookups."],
    createTools(context: TestRuntimeContext) {
      factoryCalls.push("plugin");
      const secret = context.bindings.pluginSecret;
      return [
        defineTool({
          name: "test_search",
          description: "Search the configured test source.",
          input: v.object({ query: v.string() }),
          output: v.string(),
          async run({ data }) {
            toolCalls.push(`${secret}:${data.query}`);
            return { output: "search complete" };
          },
        }),
      ];
    },
  };
}

function createTestAddon(factoryCalls: string[], toolCalls: string[]) {
  return {
    id: "test-triage",
    kind: "addon" as const,
    instructions: ["Triage requests after gathering facts."],
    createTools(context: TestRuntimeContext) {
      factoryCalls.push("addon");
      const route = context.bindings.addonRoute;
      return [
        defineTool({
          name: "test_triage",
          description: "Classify one test request.",
          input: v.object({ request: v.string() }),
          output: v.string(),
          async run({ data }) {
            toolCalls.push(`${route}:${data.request}`);
            return { output: "triage complete" };
          },
        }),
      ];
    },
  };
}

const config = defineAgentConfig({
  name: "Neutral Agent",
  description: "Answers Slack conversations.",
  ownerInstructions: "Prefer short answers.",
});

describe("neutral core composition", () => {
  test("applies neutral defaults and fixes the Workers AI model", () => {
    expect(config.retention).toEqual({ privateDays: 7, channelDays: 15 });
    expect(PRIVATE_RETENTION_DAYS).toBe(7);
    expect(CHANNEL_RETENTION_DAYS).toBe(15);
    expect(MODEL).toBe("cloudflare/@cf/zai-org/glm-4.7-flash");
    expect(CLOUDFLARE_TRACING_CONTENT).toBe(false);
  });

  test("places immutable security instructions before owner instructions", () => {
    const instructions = composeInstructions(config);
    expect(instructions.slice(0, -1)).toEqual([...CORE_INSTRUCTIONS]);
    expect(instructions.at(-1)).toBe("Prefer short answers.");
    expect(Object.isFrozen(instructions)).toBe(true);
    expect(Object.isFrozen(CORE_INSTRUCTIONS)).toBe(true);
  });

  test("preserves core-only instruction and tool behavior when extensions are absent", () => {
    const terminal = terminalTool();

    expect(config.plugins).toEqual([]);
    expect(config.addons).toEqual([]);
    expect(composeInstructions(config)).toEqual([
      ...CORE_INSTRUCTIONS,
      "Prefer short answers.",
    ]);
    expect(composeTools(config, undefined, terminal)).toEqual([terminal]);
  });

  test("resolves config and manifests without invoking runtime factories", async () => {
    let factoryCalls = 0;
    const staticConfig = defineAgentConfig({
      name: "Static Agent",
      description: "Imports without Worker runtime.",
      ownerInstructions: "Keep runtime values private.",
      plugins: [
        {
          id: "runtime-only",
          kind: "plugin",
          createTools() {
            factoryCalls += 1;
            throw new Error("Factory must not run during static resolution");
          },
        },
      ],
    });

    expect(factoryCalls).toBe(0);
    expect(
      generateSlackManifest(staticConfig, "https://agent.example.com"),
    ).toContain('"name": "Static Agent"');
    expect(factoryCalls).toBe(0);
    const manifestProcess = Bun.spawn(
      [
        "bun",
        "run",
        "apps/slack-agent/scripts/generate-manifest.ts",
        "https://agent.example.com",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await manifestProcess.exited).toBe(0);
    expect(await new Response(manifestProcess.stdout).text()).toContain(
      '"name": "Slack Agent"',
    );
  });

  test("creates plugin and addon tools in runtime order with secrets closure-bound", async () => {
    const factoryCalls: string[] = [];
    const toolCalls: string[] = [];
    const pluginSecret = "plugin-secret-value";
    const addonRoute = "private-addon-route";
    const extensionConfig = defineAgentConfig<TestRuntimeContext>({
      name: "Extended Agent",
      description: "Uses static extensions.",
      ownerInstructions: "Follow the owner's preferences.",
      plugins: [createTestPlugin(factoryCalls, toolCalls)],
      addons: [createTestAddon(factoryCalls, toolCalls)],
    });
    const terminal = terminalTool();
    const instructions = composeInstructions(extensionConfig);
    expect(factoryCalls).toEqual([]);
    expect(JSON.stringify(extensionConfig)).not.toContain(pluginSecret);
    expect(JSON.stringify(extensionConfig)).not.toContain(addonRoute);
    const tools = composeTools(
      extensionConfig,
      { bindings: { pluginSecret, addonRoute } },
      terminal,
    );

    expect(instructions).toEqual([
      ...CORE_INSTRUCTIONS,
      "Follow the owner's preferences.",
      "Use test search for exact lookups.",
      "Triage requests after gathering facts.",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "test_search",
      "test_triage",
      CORE_REPLY_TOOL_NAME,
    ]);
    expect(factoryCalls).toEqual(["plugin", "addon"]);
    const modelVisible = JSON.stringify({
      instructions,
      tools: tools.map(({ name, description, input }) => ({
        name,
        description,
        input,
      })),
    });
    expect(modelVisible).not.toContain(pluginSecret);
    expect(modelVisible).not.toContain(addonRoute);

    await tools[0]?.run({ data: { query: "invoice" } } as Parameters<
      (typeof tools)[number]["run"]
    >[0]);
    await tools[1]?.run({ data: { request: "refund" } } as Parameters<
      (typeof tools)[number]["run"]
    >[0]);
    expect(toolCalls).toEqual([
      `${pluginSecret}:invoice`,
      `${addonRoute}:refund`,
    ]);
  });

  test("rejects duplicate extension ids across kinds and reply tool shadowing", () => {
    expect(() =>
      defineAgentConfig({
        name: "Duplicate Agent",
        description: "Rejects duplicates.",
        ownerInstructions: "Be concise.",
        plugins: [{ id: "shared", kind: "plugin" }],
        addons: [{ id: "shared", kind: "addon" }],
      }),
    ).toThrow("Duplicate agent extension id: shared");
    const shadowConfig = defineAgentConfig({
      name: "Shadow Agent",
      description: "Rejects reply shadowing.",
      ownerInstructions: "Be concise.",
      plugins: [
        {
          id: "shadow",
          kind: "plugin",
          createTools() {
            return [
              defineTool({
                name: CORE_REPLY_TOOL_NAME,
                description: "Shadow reply.",
                async run() {
                  return "shadowed";
                },
              }),
            ];
          },
        },
      ],
    });
    expect(() => composeTools(shadowConfig, undefined, terminalTool())).toThrow(
      `Agent extensions cannot register ${CORE_REPLY_TOOL_NAME}`,
    );
  });

  test("copies and freezes resolved extension collections", () => {
    const instructions = ["Original plugin instruction."];
    const createTools = () => [];
    const plugins = [
      { id: "mutable", kind: "plugin" as const, instructions, createTools },
    ];
    const immutableConfig = defineAgentConfig({
      name: "Immutable Agent",
      description: "Freezes extensions.",
      ownerInstructions: "Keep definitions stable.",
      plugins,
      addons: [{ id: "empty", kind: "addon" }],
    });

    instructions.push("Late instruction.");
    plugins.push({
      id: "late",
      kind: "plugin",
      instructions: [],
      createTools,
    });

    expect(immutableConfig.plugins).toHaveLength(1);
    expect(immutableConfig.plugins[0]?.instructions).toEqual([
      "Original plugin instruction.",
    ]);
    expect(immutableConfig.plugins[0]?.createTools).toBe(createTools);
    expect(immutableConfig.addons[0]).toMatchObject({
      id: "empty",
      instructions: [],
      createTools: undefined,
    });
    expect(Object.isFrozen(immutableConfig.plugins)).toBe(true);
    expect(Object.isFrozen(immutableConfig.addons)).toBe(true);
    expect(Object.isFrozen(immutableConfig.plugins[0])).toBe(true);
    expect(Object.isFrozen(immutableConfig.plugins[0]?.instructions)).toBe(
      true,
    );
  });

  test("rejects empty extension instructions", () => {
    expect(() =>
      defineAgentConfig({
        name: "Invalid Agent",
        description: "Rejects empty instructions.",
        ownerInstructions: "Be concise.",
        addons: [{ id: "invalid", kind: "addon", instructions: [" "] }],
      }),
    ).toThrow("Agent extension invalid requires non-empty instructions");
  });
});

describe("terminal Slack delivery", () => {
  test("binds destination and credential, sanitizes text, and posts once", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> =
      [];
    const tool = createReplyTool(
      { channelId: "C123", threadTs: "171.2" },
      "xoxb-trusted-token",
      async (input, init) => {
        requests.push({ input, init });
        return Response.json({ ok: true, ts: "171.3" });
      },
    );
    const input = {
      data: {
        text: "<!channel> <@U999> xoxb-leaked SIGNING_SECRET=oops\n\n\nDone",
      },
    } as Parameters<typeof tool.run>[0];

    expect(await tool.run(input)).toEqual({
      output: "posted",
      terminate: true,
    });
    expect(await tool.run(input)).toEqual({ output: "already posted" });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.input).toBe("https://slack.com/api/chat.postMessage");
    expect(request.init?.headers).toMatchObject({
      authorization: "Bearer xoxb-trusted-token",
      "content-type": "application/json; charset=utf-8",
    });
    if (typeof request.init?.body !== "string")
      throw new Error("Expected JSON body");
    expect(JSON.parse(request.init.body)).toEqual({
      channel: "C123",
      thread_ts: "171.2",
      text: "&lt;@U999> [secret] [internal configuration]\n\nDone",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("enforces Slack's safe length limit", async () => {
    let delivered = "";
    const tool = createReplyTool(
      { channelId: "C123", threadTs: "171.2" },
      "xoxb-trusted-token",
      async (_input, init) => {
        if (typeof init?.body !== "string")
          throw new Error("Expected JSON body");
        delivered = JSON.parse(init.body).text;
        return Response.json({ ok: true });
      },
    );
    await tool.run({ data: { text: "a".repeat(4_100) } } as Parameters<
      typeof tool.run
    >[0]);
    expect(delivered).toHaveLength(3_893);
    expect(delivered.endsWith("\n\n(truncated)")).toBe(true);
  });

  test("coalesces concurrent terminal delivery attempts", async () => {
    let posts = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = createReplyTool(
      { channelId: "C123", threadTs: "171.2" },
      "xoxb-trusted-token",
      async () => {
        posts += 1;
        await blocked;
        return Response.json({ ok: true });
      },
    );
    const input = { data: { text: "hello" } } as Parameters<typeof tool.run>[0];
    const first = tool.run(input);
    const second = tool.run(input);
    expect(posts).toBe(1);
    release?.();
    expect(await Promise.all([first, second])).toEqual([
      { output: "posted", terminate: true },
      { output: "already posted" },
    ]);
  });
});

describe("D1 claim lifecycle", () => {
  test("releases only failed claims so a failed event can be retried", async () => {
    const seen = new Set<string>();
    const db = {
      prepare(sql: string) {
        let eventId = "";
        return {
          bind(value: unknown) {
            eventId = String(value);
            return this;
          },
          async run() {
            if (sql.startsWith("INSERT")) {
              if (seen.has(eventId)) return { meta: { changes: 0 } };
              seen.add(eventId);
              return { meta: { changes: 1 } };
            }
            if (sql.includes("WHERE event_id")) seen.delete(eventId);
            return { meta: { changes: 1 } };
          },
        };
      },
    } as unknown as D1Database;
    let failure: unknown;
    try {
      await claimAndRun(db, "Ev-failed", async () => {
        throw new Error("dispatch failed");
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error("dispatch failed"));
    let completed = 0;
    await claimAndRun(db, "Ev-failed", async () => {
      completed += 1;
    });
    await claimAndRun(db, "Ev-failed", async () => {
      completed += 1;
    });
    expect(completed).toBe(1);
  });
});

describe("sliding retention", () => {
  test("schedules the new expiry before cancelling prior expiry schedules", async () => {
    const calls: string[] = [];
    await replaceRetention(
      {
        async listSchedules() {
          return [
            { id: "old", callback: "expireConversation", payload: {}, time: 1 },
            { id: "other", callback: "other", payload: {}, time: 2 },
          ];
        },
        async schedule(seconds, callback, payload) {
          calls.push(`schedule:${seconds}:${callback}:${payload.surface}`);
          return { id: "new", callback, payload, time: 3 };
        },
        async cancelSchedule(id) {
          calls.push(`cancel:${id}`);
          return true;
        },
      },
      "private",
      7,
      15,
    );
    expect(calls).toEqual([
      "schedule:604800:expireConversation:private",
      "cancel:old",
    ]);
    calls.length = 0;
    await replaceRetention(
      {
        async listSchedules() {
          return [];
        },
        async schedule(seconds, callback, payload) {
          calls.push(`schedule:${seconds}:${callback}:${payload.surface}`);
          return { id: "channel", callback, payload, time: 4 };
        },
        async cancelSchedule() {
          return true;
        },
      },
      "channel",
      7,
      15,
    );
    expect(calls).toEqual(["schedule:1296000:expireConversation:channel"]);
  });

  test("destroys the whole conversation only for the latest expiry", async () => {
    let destroyed = 0;
    const latest = {
      id: "latest",
      callback: "expireConversation",
      payload: {},
      time: 2,
    };
    const agent = {
      async listSchedules() {
        return [
          { id: "stale", callback: "expireConversation", payload: {}, time: 1 },
          latest,
        ];
      },
      async destroy() {
        destroyed += 1;
      },
    };
    await expireLatest(agent, {
      id: "stale",
      callback: "expireConversation",
      payload: {},
      time: 1,
    });
    await expireLatest(agent, latest);
    expect(destroyed).toBe(1);
  });
});

describe("readiness and manifest", () => {
  test("names missing required fields without exposing values", () => {
    expect(
      missingReadiness(
        {
          signingSecret: "",
          botToken: "secret-value",
          teamId: "",
          appId: "A123",
        },
        {},
      ),
    ).toEqual([
      "SLACK_SIGNING_SECRET",
      "SLACK_TEAM_ID",
      "DB",
      "FLUE_SLACK_AGENT_AGENT",
      "AI",
    ]);
  });

  test("generates a neutral manifest from config and deployed URL", () => {
    const manifest = JSON.parse(
      generateSlackManifest(config, "https://agent.example.com/path"),
    );
    expect(manifest.display_information).toEqual({
      name: "Neutral Agent",
      description: "Answers Slack conversations.",
    });
    expect(manifest.features.app_home).toEqual({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.agent_view).toEqual({
      agent_description: "Answers Slack conversations.",
    });
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: "https://agent.example.com/channels/slack/events",
      bot_events: ["app_mention", "message.im"],
    });
    expect(JSON.stringify(manifest)).not.toMatch(/xox[a-z]-|[UA][A-Z0-9]{8,}/);
  });
});
