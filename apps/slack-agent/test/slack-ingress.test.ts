import { beforeEach, describe, expect, test } from "bun:test";
import {
  createSlackIngress,
  defineAgentConfig,
  setSuggestedPrompts,
} from "@agentic-slack/core";
import type {
  SlackBlockActionsPayload,
  SlackCoreBindings,
} from "@agentic-slack/core";
import type { ConversationLifecycleAgent } from "../../../packages/core/src/retention.ts";
import * as v from "valibot";
import { createApp } from "../src/app.ts";
import { mockCloudflareWorkers, workerWaitUntil } from "./module-mocks.ts";

const trusted = {
  appId: "A123",
  botToken: "xoxb-test",
  signingSecret: "signing-secret-for-tests-1234567890",
  teamId: "T123",
};

// The lifecycle handler defers its Slack call to the worker's `waitUntil`, so
// the runtime module has to stand in for `cloudflare:workers` before it loads.
await mockCloudflareWorkers({ SLACK_BOT_TOKEN: trusted.botToken });
const { createLifecycleHandler } = await import("../src/lifecycle.ts");

beforeEach(() => {
  workerWaitUntil.length = 0;
});

class FakeD1 {
  readonly seen = new Set<string>();
  rejectClaim = false;
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
          if (this.rejectClaim) {
            return Promise.reject(new Error("claim failed"));
          }
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
  readonly user?: string;
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

const blockActions: SlackBlockActionsPayload = {
  actions: [
    {
      action_id: "approval_approve",
      block_id: "approval",
      type: "button",
      value: "req-1",
    },
  ],
  api_app_id: "A123",
  channel: { id: "D1" },
  container: { thread_ts: "171.1", type: "message" },
  message: { thread_ts: "171.1", ts: "171.2" },
  team: { id: "T123" },
  type: "block_actions",
  user: { id: "U1" },
};

const signedBody = async (
  body: string,
  contentType: string,
  url: string,
): Promise<Request> => {
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
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
};

const signedRequest = (
  payload: AssistantEnvelope | EventEnvelope,
  url = "https://example.com/events",
): Promise<Request> =>
  signedBody(JSON.stringify(payload), "application/json", url);

const assistantStarted = (userId: string): AssistantEnvelope => ({
  api_app_id: "A123",
  event: {
    assistant_thread: {
      channel_id: "D999",
      context: {},
      thread_ts: "180.1",
      user_id: userId,
    },
    event_ts: "181.9",
    type: "assistant_thread_started",
  },
  event_id: "Ev-assistant-allowlist",
  team_id: "T123",
  type: "event_callback",
});

// Slack posts interactivity as a form field holding the JSON payload.
const signedInteraction = (
  payload: typeof blockActions,
  url = "https://example.com/interactions",
): Promise<Request> =>
  signedBody(
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    "application/x-www-form-urlencoded",
    url,
  );

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
  test("claims and dispatches before acknowledging, and deduplicates all side effects by event_id", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const channel = createSlackIngress(trusted, (turn, instanceId) => {
      turns.push(`${turn.text}:${instanceId}`);
      return Promise.resolve();
    });
    const bindings = testBindings(db);

    const threadedMention = event({ thread_ts: "170.root" });
    const first = await channel
      .route()
      .request(await signedRequest(threadedMention), undefined, bindings);
    expect(first.status).toBe(200);
    expect(db.seen.has("Ev123")).toBe(true);
    expect(turns).toEqual(["hello:slack:v1:T123:C123:170.root"]);

    const duplicate = await channel
      .route()
      .request(await signedRequest(threadedMention), undefined, bindings);
    expect(duplicate.status).toBe(200);
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
      .request(await signedRequest(directMessage), undefined, bindings);
    expect(directResponse.status).toBe(200);
    expect(turns.at(-1)).toBe("private hello:slack:v1:T123:D123:D123");
  });

  test("rejects invalid signatures, mismatched identity, bots, subtypes, and empty turns", async () => {
    const db = new FakeD1();
    const admitted: string[] = [];
    const channel = createSlackIngress(trusted, (turn) => {
      admitted.push(turn.eventId);
      return Promise.resolve();
    });
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
          .request(await signedRequest(payload), undefined, bindings);
        expect(response.status).toBe(200);
      }),
    );
    expect(admitted).toEqual([]);
  });
});

describe("owner allowlist", () => {
  const owner = { ...trusted, allowedUserIds: ["U123"] };
  const directMessage = (userId: string, eventId: string): EventEnvelope => ({
    ...event(),
    event: {
      channel: "D123",
      channel_type: "im",
      text: "private hello",
      ts: "172.1",
      type: "message",
      user: userId,
    },
    event_id: eventId,
  });

  test("claims and dispatches a listed user's mention and DM", async () => {
    const db = new FakeD1();
    const admitted: string[] = [];
    const channel = createSlackIngress(owner, (turn) => {
      admitted.push(`${turn.userId}:${turn.eventId}`);
      return Promise.resolve();
    });
    const bindings = testBindings(db);

    const mention = await channel
      .route()
      .request(await signedRequest(event()), undefined, bindings);
    expect(mention.status).toBe(200);
    expect(db.seen.has("Ev123")).toBe(true);

    const dm = await channel
      .route()
      .request(
        await signedRequest(directMessage("U123", "Ev-dm")),
        undefined,
        bindings,
      );
    expect(dm.status).toBe(200);
    expect(db.seen.has("Ev-dm")).toBe(true);
    expect(admitted).toEqual(["U123:Ev123", "U123:Ev-dm"]);
  });

  // Slack must stop redelivering a refused event, and nothing may follow it:
  // no claim row, no reaction, no reply and no model call.
  test("answers 2xx and claims nothing for a mention, a DM or an assistant start from anyone else", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const lifecycles: string[] = [];
    const channel = createSlackIngress(
      owner,
      (turn) => {
        turns.push(turn.eventId);
        return Promise.resolve();
      },
      (lifecycle) => {
        lifecycles.push(lifecycle.eventId);
        return Promise.resolve();
      },
    );
    const bindings = testBindings(db);

    const refused: (AssistantEnvelope | EventEnvelope)[] = [
      event({ user: "U999" }),
      directMessage("U999", "Ev-dm-refused"),
      assistantStarted("U999"),
    ];
    await Promise.all(
      refused.map(async (payload) => {
        const response = await channel
          .route()
          .request(await signedRequest(payload), undefined, bindings);
        expect(response.status).toBe(200);
      }),
    );

    expect(db.seen.size).toBe(0);
    expect(turns).toEqual([]);
    expect(lifecycles).toEqual([]);
  });
});

describe("ingress acknowledgement", () => {
  test("answers non-2xx when the claim fails, so Slack retries the delivery", async () => {
    const db = new FakeD1();
    db.rejectClaim = true;
    const turns: string[] = [];
    const channel = createSlackIngress(trusted, (turn) => {
      turns.push(turn.eventId);
      return Promise.resolve();
    });

    const response = await channel
      .route()
      .request(await signedRequest(event()), undefined, testBindings(db));

    expect(response.status).toBe(500);
    expect(turns).toEqual([]);
  });

  test("answers non-2xx when the dispatch fails, so Slack retries the delivery", async () => {
    const db = new FakeD1();
    let attempts = 0;
    const channel = createSlackIngress(trusted, () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("dispatch failed"))
        : Promise.resolve();
    });
    const bindings = testBindings(db);

    const failed = await channel
      .route()
      .request(await signedRequest(event()), undefined, bindings);

    expect(failed.status).toBe(500);

    const retried = await channel
      .route()
      .request(await signedRequest(event()), undefined, bindings);

    expect(retried.status).toBe(200);
    expect(attempts).toBe(2);
  });
});

describe("approval interactions", () => {
  const decisions: SlackBlockActionsPayload[] = [];
  const handler = (payload: SlackBlockActionsPayload) => {
    decisions.push(payload);
    return Promise.resolve();
  };
  const decide = async (
    payload: typeof blockActions,
    overrides: { apiAppId?: string; teamId?: string } = {},
  ) => {
    const channel = createSlackIngress(
      trusted,
      () => Promise.resolve(),
      undefined,
      handler,
    );
    return await channel.route().request(
      await signedInteraction({
        ...payload,
        api_app_id: overrides.apiAppId ?? payload.api_app_id,
        team: { id: overrides.teamId ?? "T123" },
      }),
      undefined,
      testBindings(new FakeD1()),
    );
  };

  test("routes a signed decision from the configured workspace to the handler", async () => {
    decisions.length = 0;
    const response = await decide(blockActions);
    expect(response.status).toBe(200);
    expect(decisions).toEqual([blockActions]);
  });

  test("rejects an unsigned decision", async () => {
    decisions.length = 0;
    const channel = createSlackIngress(
      trusted,
      () => Promise.resolve(),
      undefined,
      handler,
    );
    const response = await channel
      .route()
      .request("https://example.com/interactions", {
        body: new URLSearchParams({
          payload: JSON.stringify(blockActions),
        }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    expect(response.status).toBe(401);
    expect(decisions).toEqual([]);
  });

  test("ignores a decision from another workspace or app", async () => {
    decisions.length = 0;
    for (const overrides of [{ teamId: "T999" }, { apiAppId: "A999" }]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await decide(blockActions, overrides);
      expect(response.status).toBe(200);
    }
    expect(decisions).toEqual([]);
  });

  test("answers non-2xx when the decision handler fails, so Slack retries", async () => {
    const channel = createSlackIngress(
      trusted,
      () => Promise.resolve(),
      undefined,
      () => Promise.reject(new Error("decision failed")),
    );
    const response = await channel
      .route()
      .request(
        await signedInteraction(blockActions),
        undefined,
        testBindings(new FakeD1()),
      );
    expect(response.status).toBe(500);
  });

  // The route is mounted only when a decision handler exists, so a deployment
  // with no gated tool does not expose an endpoint that can only answer 200.
  test("does not mount the interactions route without a decision handler", async () => {
    const channel = createSlackIngress(trusted, () => Promise.resolve());

    const response = await channel
      .route()
      .request(
        await signedInteraction(blockActions),
        undefined,
        testBindings(new FakeD1()),
      );

    expect(response.status).toBe(404);
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
    const bindings = testBindings(db);

    const deliver = async () => {
      const response = await channel
        .route()
        .request(
          await signedRequest(assistantThreadStarted),
          undefined,
          bindings,
        );
      expect(response.status).toBe(200);
    };
    await deliver();
    await deliver();
    await Promise.all(workerWaitUntil);

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

  // A permanent Slack refusal is not a transient failure: retrying it three
  // times only burns Slack's redeliveries, so the ack must not turn it into a
  // 500. The claim stays, which also dedupes the redelivery.
  test("answers 200 and reports when Slack refuses the assistant prompts for good", async () => {
    const db = new FakeD1();
    let attempts = 0;
    const reported: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      reported.push(args);
    };
    try {
      const channel = createSlackIngress(
        trusted,
        () => Promise.resolve(),
        createLifecycleHandler(
          defineAgentConfig({
            description: "Answers Slack conversations.",
            name: "Operator Agent",
            ownerInstructions: "Prefer short answers.",
            suggestedPrompts: [{ message: "What changed?", title: "Recap" }],
          }),
          trusted.botToken,
          () => {
            attempts += 1;
            return Promise.resolve(
              Response.json({ error: "not_allowed", ok: false }),
            );
          },
        ),
      );
      const bindings = testBindings(db);
      const deliver = async () =>
        await channel
          .route()
          .request(
            await signedRequest(assistantThreadStarted),
            undefined,
            bindings,
          );

      const first = await deliver();
      const redelivered = await deliver();
      await Promise.all(workerWaitUntil);
      expect(first.status).toBe(200);
      expect(redelivered.status).toBe(200);
    } finally {
      console.error = originalError;
    }

    expect(attempts).toBe(1);
    expect(reported).toHaveLength(1);
  });

  // Slack budgets three seconds for the Events API ack, and the prompt call is
  // the only Slack round-trip on this path. A Slack that never answers must not
  // hold the ack open; the side effect is best-effort and the claim is durable.
  test("acknowledges an assistant-thread start without waiting on the prompt call", async () => {
    const db = new FakeD1();
    let calls = 0;
    const channel = createSlackIngress(
      trusted,
      () => Promise.resolve(),
      createLifecycleHandler(
        defineAgentConfig({
          description: "Answers Slack conversations.",
          name: "Operator Agent",
          ownerInstructions: "Prefer short answers.",
          suggestedPrompts: [{ message: "What changed?", title: "Recap" }],
        }),
        trusted.botToken,
        () => {
          calls += 1;
          return Promise.withResolvers<Response>().promise;
        },
      ),
    );

    const response = await channel
      .route()
      .request(
        await signedRequest(assistantThreadStarted),
        undefined,
        testBindings(db),
      );

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(workerWaitUntil).toHaveLength(1);
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
          .request(await signedRequest(payload), undefined, bindings);
        expect(response.status).toBe(200);
      }),
    );
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

    const response = await app.request(
      await signedRequest(
        assistantThreadStarted,
        "https://example.com/channels/slack/events",
      ),
      undefined,
      testBindings(db),
    );
    expect(response.status).toBe(200);
    await Promise.all(workerWaitUntil);

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

    const response = await app.request(
      await signedRequest(
        assistantThreadStarted,
        "https://example.com/channels/slack/events",
      ),
      undefined,
      testBindings(db),
    );
    expect(response.status).toBe(200);
    await Promise.all(workerWaitUntil);

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
