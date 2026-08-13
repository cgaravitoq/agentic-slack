import { describe, expect, test } from "bun:test";
import {
  CHANNEL_RETENTION_DAYS,
  claimAndRun,
  CLOUDFLARE_TRACING_CONTENT,
  composeInstructions,
  CORE_INSTRUCTIONS,
  createReplyTool,
  defineAgentConfig,
  expireLatest,
  generateSlackManifest,
  missingReadiness,
  MODEL,
  PRIVATE_RETENTION_DAYS,
  replaceRetention,
} from "@agentic-slack/core";

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
