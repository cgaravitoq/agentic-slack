import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { FlueLogger } from "@flue/runtime";
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
  extractAssistantText,
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

const terminalTool = () =>
  defineTool({
    description: "Reply.",
    name: CORE_REPLY_TOOL_NAME,
    run() {
      return Promise.resolve({ output: "posted", terminate: true });
    },
  });

const createTools = () => [];

const isD1Database = (value: object): value is D1Database => {
  const entry = Object.entries(value).find(([key]) => key === "prepare");
  return typeof entry?.[1] === "function";
};

const noopLogger: FlueLogger = {
  error() {},
  info() {},
  warn() {},
};
const runContext = <T>(data: T) => ({
  data,
  log: noopLogger,
  toolCallId: "test-call",
});

const createTestPlugin = (factoryCalls: string[], toolCalls: string[]) => ({
  createTools(context: TestRuntimeContext) {
    factoryCalls.push("plugin");
    const secret = context.bindings.pluginSecret;
    return [
      defineTool({
        description: "Search the configured test source.",
        input: v.object({ query: v.string() }),
        name: "test_search",
        output: v.string(),
        run({ data }) {
          toolCalls.push(`${secret}:${data.query}`);
          return Promise.resolve({ output: "search complete" });
        },
      }),
    ];
  },
  id: "test-search",
  instructions: ["Use test search for exact lookups."],
  kind: "plugin" as const,
});

const createTestAddon = (factoryCalls: string[], toolCalls: string[]) => ({
  createTools(context: TestRuntimeContext) {
    factoryCalls.push("addon");
    const route = context.bindings.addonRoute;
    return [
      defineTool({
        description: "Classify one test request.",
        input: v.object({ request: v.string() }),
        name: "test_triage",
        output: v.string(),
        run({ data }) {
          toolCalls.push(`${route}:${data.request}`);
          return Promise.resolve({ output: "triage complete" });
        },
      }),
    ];
  },
  id: "test-triage",
  instructions: ["Triage requests after gathering facts."],
  kind: "addon" as const,
});

const config = defineAgentConfig({
  description: "Answers Slack conversations.",
  name: "Neutral Agent",
  ownerInstructions: "Prefer short answers.",
});

describe("neutral core composition", () => {
  test("applies neutral defaults and fixes the Workers AI model", () => {
    expect(config.retention).toEqual({ channelDays: 15, privateDays: 7 });
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
      description: "Imports without Worker runtime.",
      name: "Static Agent",
      ownerInstructions: "Keep runtime values private.",
      plugins: [
        {
          createTools() {
            factoryCalls += 1;
            throw new Error("Factory must not run during static resolution");
          },
          id: "runtime-only",
          kind: "plugin",
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
        fileURLToPath(
          new URL("../scripts/generate-manifest.ts", import.meta.url),
        ),
        "https://agent.example.com",
      ],
      { stderr: "pipe", stdout: "pipe" },
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
      addons: [createTestAddon(factoryCalls, toolCalls)],
      description: "Uses static extensions.",
      name: "Extended Agent",
      ownerInstructions: "Follow the owner's preferences.",
      plugins: [createTestPlugin(factoryCalls, toolCalls)],
    });
    const terminal = terminalTool();
    const instructions = composeInstructions(extensionConfig);
    expect(factoryCalls).toEqual([]);
    expect(JSON.stringify(extensionConfig)).not.toContain(pluginSecret);
    expect(JSON.stringify(extensionConfig)).not.toContain(addonRoute);
    const tools = composeTools(
      extensionConfig,
      { bindings: { addonRoute, pluginSecret } },
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
        description,
        input,
        name,
      })),
    });
    expect(modelVisible).not.toContain(pluginSecret);
    expect(modelVisible).not.toContain(addonRoute);

    await tools[0]?.run(runContext({ query: "invoice" }));
    await tools[1]?.run(runContext({ request: "refund" }));
    expect(toolCalls).toEqual([
      `${pluginSecret}:invoice`,
      `${addonRoute}:refund`,
    ]);
  });

  test("rejects duplicate extension ids across kinds and reply tool shadowing", () => {
    expect(() =>
      defineAgentConfig({
        addons: [{ id: "shared", kind: "addon" }],
        description: "Rejects duplicates.",
        name: "Duplicate Agent",
        ownerInstructions: "Be concise.",
        plugins: [{ id: "shared", kind: "plugin" }],
      }),
    ).toThrow("Duplicate agent extension id: shared");
    const shadowConfig = defineAgentConfig({
      description: "Rejects reply shadowing.",
      name: "Shadow Agent",
      ownerInstructions: "Be concise.",
      plugins: [
        {
          createTools() {
            return [
              defineTool({
                description: "Shadow reply.",
                name: CORE_REPLY_TOOL_NAME,
                run() {
                  return Promise.resolve("shadowed");
                },
              }),
            ];
          },
          id: "shadow",
          kind: "plugin",
        },
      ],
    });
    expect(() => composeTools(shadowConfig, undefined, terminalTool())).toThrow(
      `Agent extensions cannot register ${CORE_REPLY_TOOL_NAME}`,
    );
  });

  test("copies and freezes resolved extension collections", () => {
    const instructions = ["Original plugin instruction."];
    const plugins = [
      { createTools, id: "mutable", instructions, kind: "plugin" as const },
    ];
    const immutableConfig = defineAgentConfig({
      addons: [{ id: "empty", kind: "addon" }],
      description: "Freezes extensions.",
      name: "Immutable Agent",
      ownerInstructions: "Keep definitions stable.",
      plugins,
    });

    instructions.push("Late instruction.");
    plugins.push({
      createTools,
      id: "late",
      instructions: [],
      kind: "plugin",
    });

    expect(immutableConfig.plugins).toHaveLength(1);
    expect(immutableConfig.plugins[0]?.instructions).toEqual([
      "Original plugin instruction.",
    ]);
    expect(immutableConfig.plugins[0]?.createTools).toBe(createTools);
    expect(immutableConfig.addons[0]).toMatchObject({
      createTools: undefined,
      id: "empty",
      instructions: [],
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
        addons: [{ id: "invalid", instructions: [" "], kind: "addon" }],
        description: "Rejects empty instructions.",
        name: "Invalid Agent",
        ownerInstructions: "Be concise.",
      }),
    ).toThrow("Agent extension invalid requires non-empty instructions");
  });
});

describe("terminal Slack delivery", () => {
  test("joins text blocks and ignores thinking and tool calls", () => {
    const content = [
      { text: "First", type: "text" },
      { thinking: "hidden reasoning", type: "thinking" },
      { text: "Second", type: "text" },
      { arguments: {}, id: "c1", name: "x", type: "toolCall" },
    ];
    expect(extractAssistantText(content)).toBe("First\nSecond");
  });

  test("returns an empty string for empty or undefined content", () => {
    expect(extractAssistantText()).toBe("");
    expect(extractAssistantText([])).toBe("");
    expect(extractAssistantText([{ text: "", type: "text" }])).toBe("");
  });

  test("binds destination and credential, sanitizes text, and posts once", async () => {
    const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const tool = createReplyTool(
      { channelId: "C123", threadTs: "171.2" },
      "xoxb-trusted-token",
      (input, init) => {
        requests.push({ init, input });
        return Promise.resolve(Response.json({ ok: true, ts: "171.3" }));
      },
    );
    const input = runContext({
      text: "<!channel> <@U999> xoxb-leaked SIGNING_SECRET=oops\n\n\nDone",
    });

    expect(await tool.run(input)).toEqual({
      output: "posted",
      terminate: true,
    });
    expect(await tool.run(input)).toEqual({ output: "already posted" });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.input).toBe("https://slack.com/api/chat.postMessage");
    expect(request.init?.headers).toMatchObject({
      authorization: "Bearer xoxb-trusted-token",
      "content-type": "application/json; charset=utf-8",
    });
    if (typeof request.init?.body !== "string") {
      throw new TypeError("Expected JSON body");
    }
    expect(JSON.parse(request.init.body)).toEqual({
      channel: "C123",
      text: "&lt;@U999> [secret] [internal configuration]\n\nDone",
      thread_ts: "171.2",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("enforces Slack's safe length limit", async () => {
    let delivered = "";
    const tool = createReplyTool(
      { channelId: "C123", threadTs: "171.2" },
      "xoxb-trusted-token",
      (_input, init) => {
        if (typeof init?.body !== "string") {
          return Promise.reject(new Error("Expected JSON body"));
        }
        delivered = v.parse(
          v.object({ text: v.string() }),
          JSON.parse(init.body),
        ).text;
        return Promise.resolve(Response.json({ ok: true }));
      },
    );
    await tool.run(runContext({ text: "a".repeat(4100) }));
    expect(delivered).toHaveLength(3893);
    expect(delivered.endsWith("\n\n(truncated)")).toBe(true);
  });

  test("coalesces concurrent terminal delivery attempts", async () => {
    let posts = 0;
    const { promise: blocked, resolve: release } =
      Promise.withResolvers<undefined>();
    const tool = createReplyTool(
      { channelId: "C123", threadTs: "171.2" },
      "xoxb-trusted-token",
      async () => {
        posts += 1;
        await blocked;
        return Response.json({ ok: true });
      },
    );
    const input = runContext({ text: "hello" });
    const first = tool.run(input);
    const second = tool.run(input);
    expect(posts).toBe(1);
    release();
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
          run() {
            if (sql.startsWith("INSERT")) {
              if (seen.has(eventId)) {
                return Promise.resolve({ meta: { changes: 0 } });
              }
              seen.add(eventId);
              return Promise.resolve({ meta: { changes: 1 } });
            }
            if (sql.includes("WHERE event_id")) {
              seen.delete(eventId);
            }
            return Promise.resolve({ meta: { changes: 1 } });
          },
        };
      },
    };
    if (!isD1Database(db)) {
      throw new Error("Invalid D1 test database");
    }
    let failure: unknown;
    try {
      await claimAndRun(db, "Ev-failed", () =>
        Promise.reject(new Error("dispatch failed")),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error("dispatch failed"));
    let completed = 0;
    await claimAndRun(db, "Ev-failed", () => {
      completed += 1;
      return Promise.resolve();
    });
    await claimAndRun(db, "Ev-failed", () => {
      completed += 1;
      return Promise.resolve();
    });
    expect(completed).toBe(1);
  });
});

describe("sliding retention", () => {
  test("schedules the new expiry before cancelling prior expiry schedules", async () => {
    const calls: string[] = [];
    await replaceRetention(
      {
        cancelSchedule(id) {
          calls.push(`cancel:${id}`);
          return Promise.resolve(true);
        },
        listSchedules() {
          return Promise.resolve([
            { callback: "expireConversation", id: "old", payload: {}, time: 1 },
            { callback: "other", id: "other", payload: {}, time: 2 },
          ]);
        },
        schedule(seconds, callback, payload) {
          calls.push(`schedule:${seconds}:${callback}:${payload.surface}`);
          return Promise.resolve({ callback, id: "new", payload, time: 3 });
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
        cancelSchedule() {
          return Promise.resolve(true);
        },
        listSchedules() {
          return Promise.resolve([]);
        },
        schedule(seconds, callback, payload) {
          calls.push(`schedule:${seconds}:${callback}:${payload.surface}`);
          return Promise.resolve({ callback, id: "channel", payload, time: 4 });
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
      callback: "expireConversation",
      id: "latest",
      payload: {},
      time: 2,
    };
    const agent = {
      destroy() {
        destroyed += 1;
        return Promise.resolve();
      },
      listSchedules() {
        return Promise.resolve([
          { callback: "expireConversation", id: "stale", payload: {}, time: 1 },
          latest,
        ]);
      },
    };
    await expireLatest(agent, {
      callback: "expireConversation",
      id: "stale",
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
          appId: "A123",
          botToken: "secret-value",
          signingSecret: "",
          teamId: "",
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
    const manifest = v.parse(
      v.object({
        display_information: v.object({
          description: v.string(),
          name: v.string(),
        }),
        features: v.object({
          agent_view: v.object({ agent_description: v.string() }),
          app_home: v.object({
            messages_tab_enabled: v.boolean(),
            messages_tab_read_only_enabled: v.boolean(),
          }),
        }),
        settings: v.object({
          event_subscriptions: v.object({
            bot_events: v.array(v.string()),
            request_url: v.string(),
          }),
        }),
      }),
      JSON.parse(
        generateSlackManifest(config, "https://agent.example.com/path"),
      ),
    );
    expect(manifest.display_information).toEqual({
      description: "Answers Slack conversations.",
      name: "Neutral Agent",
    });
    expect(manifest.features.app_home).toEqual({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.agent_view).toEqual({
      agent_description: "Answers Slack conversations.",
    });
    expect(manifest.settings.event_subscriptions).toEqual({
      bot_events: ["app_mention", "message.im"],
      request_url: "https://agent.example.com/channels/slack/events",
    });
    expect(JSON.stringify(manifest)).not.toMatch(/xox[a-z]-|[UA][A-Z0-9]{8,}/u);
  });
});
