import { describe, expect, test } from "bun:test";
import {
  createSlackIngress,
  defineAgentConfig,
  setSuggestedPrompts,
} from "@agentic-slack/core";
import type {
  ConversationLifecycleAgent,
  SlackCoreBindings,
} from "@agentic-slack/core";
import * as v from "valibot";
import { createApp } from "../src/app.ts";
import { createLifecycleHandler } from "../src/lifecycle.ts";

const trusted = {
  appId: "A123",
  botToken: "xoxb-test",
  signingSecret: "signing-secret-for-tests-1234567890",
  teamId: "T123",
};

class FakeD1 {
  readonly seen = new Set<string>();
  private values: unknown[] = [];

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        this.values = values;
        return this.prepare(sql);
      },
      run: () => {
        const eventId = String(this.values[0]);
        if (sql.startsWith("INSERT")) {
          if (this.seen.has(eventId)) {
            return Promise.resolve({ meta: { changes: 0 } });
          }
          this.seen.add(eventId);
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (sql.startsWith("DELETE FROM seen_events WHERE event_id")) {
          this.seen.delete(eventId);
        }
        return Promise.resolve({ meta: { changes: 1 } });
      },
    };
  }
}

const workerBindings = v.object({
  AI: v.custom<Ai>(
    (value): value is Ai => value !== null && typeof value === "object",
  ),
  DB: v.custom<D1Database>(
    (value): value is D1Database => value !== null && typeof value === "object",
  ),
  FLUE_SLACK_AGENT_AGENT: v.custom<
    DurableObjectNamespace<ConversationLifecycleAgent>
  >(
    (value): value is DurableObjectNamespace<ConversationLifecycleAgent> =>
      value !== null && typeof value === "object",
  ),
});

const testBindings = (db: FakeD1): SlackCoreBindings => {
  const value = {
    AI: {},
    DB: db,
    FLUE_SLACK_AGENT_AGENT: {},
  };
  if (!v.is(workerBindings, value)) {
    throw new Error("Invalid test bindings");
  }
  return value;
};

interface EventOverrides {
  readonly bot_id?: string;
  readonly text?: string;
  readonly thread_ts?: string;
}

const eventEnvelope = v.object({
  api_app_id: v.string(),
  event: v.object({
    bot_id: v.optional(v.string()),
    channel: v.string(),
    channel_type: v.optional(v.string()),
    subtype: v.optional(v.string()),
    text: v.optional(v.string()),
    thread_ts: v.optional(v.string()),
    ts: v.string(),
    type: v.string(),
    user: v.string(),
  }),
  event_id: v.string(),
  team_id: v.string(),
  type: v.string(),
});
type EventEnvelope = v.InferOutput<typeof eventEnvelope>;

const assistantEnvelope = v.object({
  api_app_id: v.string(),
  event: v.object({
    assistant_thread: v.object({
      channel_id: v.string(),
      context: v.object({ channel_id: v.optional(v.string()) }),
      thread_ts: v.string(),
      user_id: v.string(),
    }),
    event_ts: v.string(),
    type: v.string(),
  }),
  event_id: v.string(),
  team_id: v.string(),
  type: v.string(),
});
type AssistantEnvelope = v.InferOutput<typeof assistantEnvelope>;

const signedRequest = async (
  payload: AssistantEnvelope | EventEnvelope,
  url = "https://example.com/events",
): Promise<Request> => {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(trusted.signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const signature = `v0=${Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  return new Request(url, {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
};

const event = (overrides: EventOverrides = {}) => ({
  api_app_id: "A123",
  event: {
    channel: "C123",
    text: "<@UAPP> hello",
    ts: "171.1",
    type: "app_mention",
    user: "U123",
    ...overrides,
  },
  event_id: "Ev123",
  team_id: "T123",
  type: "event_callback",
});

describe("signed Slack ingress", () => {
  test("acks before work and deduplicates all side effects by event_id", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const { promise: blocked, resolve: releaseWork } =
      Promise.withResolvers<undefined>();
    const channel = createSlackIngress(trusted, async (turn, instanceId) => {
      turns.push(`${turn.text}:${instanceId}`);
      await blocked;
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bindings = testBindings(db);

    const threadedMention = event({ thread_ts: "170.root" });
    const first = await channel
      .route()
      .request(
        await signedRequest(threadedMention),
        undefined,
        bindings,
        executionCtx,
      );
    expect(first.status).toBe(200);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe("hello:slack:v1:T123:C123:170.root");
    releaseWork();
    await Promise.all(pending.splice(0));

    const duplicate = await channel
      .route()
      .request(
        await signedRequest(threadedMention),
        undefined,
        bindings,
        executionCtx,
      );
    expect(duplicate.status).toBe(200);
    await Promise.all(pending.splice(0));
    expect(turns).toHaveLength(1);

    const directMessage = {
      ...event(),
      event: {
        channel: "D123",
        channel_type: "im",
        text: "private hello",
        ts: "172.1",
        type: "message",
        user: "U123",
      },
      event_id: "Ev-private",
    };
    const directResponse = await channel
      .route()
      .request(
        await signedRequest(directMessage),
        undefined,
        bindings,
        executionCtx,
      );
    expect(directResponse.status).toBe(200);
    await Promise.all(pending);
    expect(turns.at(-1)).toBe("private hello:slack:v1:T123:D123:D123");
  });

  test("rejects invalid signatures, mismatched identity, bots, subtypes, and empty turns", async () => {
    const db = new FakeD1();
    const admitted: string[] = [];
    const channel = createSlackIngress(trusted, (turn) => {
      admitted.push(turn.eventId);
      return Promise.resolve();
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bindings = testBindings(db);

    const invalid = await channel
      .route()
      .request("https://example.com/events", {
        body: JSON.stringify(event()),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    expect(invalid.status).toBe(401);

    const rejected = [
      { ...event(), event_id: "Ev-team", team_id: "T999" },
      { ...event(), api_app_id: "A999", event_id: "Ev-app" },
      event({ bot_id: "B123" }),
      {
        ...event(),
        event: {
          channel: "D1",
          channel_type: "im",
          subtype: "message_changed",
          text: "hello",
          ts: "1",
          type: "message",
          user: "U1",
        },
        event_id: "Ev-subtype",
      },
      event({ text: "<@UAPP>   " }),
      {
        ...event(),
        event: {
          channel: "D1",
          channel_type: "mpim",
          text: "hello",
          ts: "1",
          type: "message",
          user: "U1",
        },
        event_id: "Ev-im",
      },
    ];
    await Promise.all(
      rejected.map(async (payload) => {
        const response = await channel
          .route()
          .request(
            await signedRequest(payload),
            undefined,
            bindings,
            executionCtx,
          );
        expect(response.status).toBe(200);
      }),
    );
    await Promise.all(pending);
    expect(admitted).toEqual([]);
  });
});

describe("assistant thread lifecycle", () => {
  const assistantThreadStarted: AssistantEnvelope = {
    api_app_id: "A123",
    event: {
      assistant_thread: {
        channel_id: "D999",
        context: {},
        thread_ts: "180.1",
        user_id: "U123",
      },
      event_ts: "181.9",
      type: "assistant_thread_started",
    },
    event_id: "Ev-assistant",
    team_id: "T123",
    type: "event_callback",
  };

  test("sets suggested prompts once on the started thread and starts no agent turn", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const requests: {
      authorization: string | null;
      body: unknown;
      method: string;
      url: string;
    }[] = [];
    const channel = createSlackIngress(
      trusted,
      (turn) => {
        turns.push(turn.eventId);
        return Promise.resolve();
      },
      (lifecycle) =>
        setSuggestedPrompts(
          { channelId: lifecycle.channelId, threadTs: lifecycle.threadTs },
          [{ message: "What changed?", title: "Recap" }],
          trusted.botToken,
          async (input, init) => {
            const request = new Request(input, init);
            requests.push({
              authorization: request.headers.get("authorization"),
              body: await request.json(),
              method: request.method,
              url: request.url,
            });
            return Response.json({ ok: true });
          },
        ),
    );
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bindings = testBindings(db);

    const deliver = async () => {
      const response = await channel
        .route()
        .request(
          await signedRequest(assistantThreadStarted),
          undefined,
          bindings,
          executionCtx,
        );
      expect(response.status).toBe(200);
      await Promise.all(pending.splice(0));
    };
    await deliver();
    await deliver();

    expect(turns).toEqual([]);
    expect(requests).toEqual([
      {
        authorization: "Bearer xoxb-test",
        body: {
          channel_id: "D999",
          prompts: [{ message: "What changed?", title: "Recap" }],
          thread_ts: "180.1",
        },
        method: "POST",
        url: "https://slack.com/api/assistant.threads.setSuggestedPrompts",
      },
    ]);
  });

  test("rejects lifecycle events from a foreign workspace or app", async () => {
    const db = new FakeD1();
    const lifecycles: string[] = [];
    const channel = createSlackIngress(
      trusted,
      () => Promise.resolve(),
      (lifecycle) => {
        lifecycles.push(lifecycle.eventId);
        return Promise.resolve();
      },
    );
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bindings = testBindings(db);

    const rejected: AssistantEnvelope[] = [
      {
        ...assistantThreadStarted,
        event_id: "Ev-foreign-team",
        team_id: "T999",
      },
      {
        ...assistantThreadStarted,
        api_app_id: "A999",
        event_id: "Ev-foreign-app",
      },
    ];
    await Promise.all(
      rejected.map(async (payload) => {
        const response = await channel
          .route()
          .request(
            await signedRequest(payload),
            undefined,
            bindings,
            executionCtx,
          );
        expect(response.status).toBe(200);
      }),
    );
    await Promise.all(pending);
    expect(lifecycles).toEqual([]);
  });

  test("serves operator prompts through an app built by createApp", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const requests: {
      authorization: string | null;
      body: unknown;
      method: string;
      url: string;
    }[] = [];
    const operatorConfig = defineAgentConfig({
      description: "Answers Slack conversations.",
      name: "Operator Agent",
      ownerInstructions: "Prefer short answers.",
      suggestedPrompts: [
        { message: "Summarize the incident", title: "Incident recap" },
        { message: "Draft the release note", title: "Release note" },
      ],
    });
    const app = createApp(
      trusted,
      (turn) => {
        turns.push(turn.eventId);
        return Promise.resolve();
      },
      createLifecycleHandler(
        operatorConfig,
        trusted.botToken,
        async (input, init) => {
          const request = new Request(input, init);
          requests.push({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
            method: request.method,
            url: request.url,
          });
          return Response.json({ ok: true });
        },
      ),
    );
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };

    const response = await app.request(
      await signedRequest(
        assistantThreadStarted,
        "https://example.com/channels/slack/events",
      ),
      undefined,
      testBindings(db),
      executionCtx,
    );
    expect(response.status).toBe(200);
    await Promise.all(pending);

    expect(turns).toEqual([]);
    expect(requests).toEqual([
      {
        authorization: "Bearer xoxb-test",
        body: {
          channel_id: "D999",
          prompts: [
            { message: "Summarize the incident", title: "Incident recap" },
            { message: "Draft the release note", title: "Release note" },
          ],
          thread_ts: "180.1",
        },
        method: "POST",
        url: "https://slack.com/api/assistant.threads.setSuggestedPrompts",
      },
    ]);
  });

  test("serves a second operator config and credential through the same seam", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const requests: {
      authorization: string | null;
      body: unknown;
      method: string;
      url: string;
    }[] = [];
    const secondTrusted = { ...trusted, botToken: "xoxb-second" };
    const secondConfig = defineAgentConfig({
      description: "Answers Slack conversations.",
      name: "Second Operator Agent",
      ownerInstructions: "Prefer short answers.",
      suggestedPrompts: [
        { message: "Draft the release note", title: "Release note" },
        { message: "Summarize the incident", title: "Incident recap" },
        { message: "List the open questions", title: "Open questions" },
      ],
    });
    const app = createApp(
      secondTrusted,
      (turn) => {
        turns.push(turn.eventId);
        return Promise.resolve();
      },
      createLifecycleHandler(
        secondConfig,
        secondTrusted.botToken,
        async (input, init) => {
          const request = new Request(input, init);
          requests.push({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
            method: request.method,
            url: request.url,
          });
          return Response.json({ ok: true });
        },
      ),
    );
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };

    const response = await app.request(
      await signedRequest(
        assistantThreadStarted,
        "https://example.com/channels/slack/events",
      ),
      undefined,
      testBindings(db),
      executionCtx,
    );
    expect(response.status).toBe(200);
    await Promise.all(pending);

    expect(turns).toEqual([]);
    expect(requests).toEqual([
      {
        authorization: "Bearer xoxb-second",
        body: {
          channel_id: "D999",
          prompts: [
            { message: "Draft the release note", title: "Release note" },
            { message: "Summarize the incident", title: "Incident recap" },
            { message: "List the open questions", title: "Open questions" },
          ],
          thread_ts: "180.1",
        },
        method: "POST",
        url: "https://slack.com/api/assistant.threads.setSuggestedPrompts",
      },
    ]);
  });
});
