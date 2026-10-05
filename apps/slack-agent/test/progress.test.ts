import { describe, expect, test } from "bun:test";
import {
  createSlackProgressEndpoint,
  defineAgentConfig,
  MODEL_PROVIDER_CLOUDFLARE,
} from "@agentic-slack/core";
import type {
  ModelBrokerBinding,
  SlackCoreBindings,
} from "@agentic-slack/core";
import type { ResolvedSlackProgressConfig } from "../../../packages/core/src/progress.ts";
import type { ConversationLifecycleAgent } from "../../../packages/core/src/retention.ts";
import * as v from "valibot";
import { createApp } from "../src/app.ts";

const BEARER = "progress-bearer-for-tests";
const trusted = {
  appId: "A123",
  botToken: "xoxb-test",
  signingSecret: "signing-secret-for-tests-1234567890",
  teamId: "T123",
};

class FakeD1 {
  readonly admissions = new Set<string>();
  readonly roots = new Map<string, { root_text: string; root_ts: string }>();
  readonly seen = new Set<string>();
  private values: unknown[] = [];

  prepare(sql: string) {
    return {
      all: () => {
        if (sql.includes("slack_channel_admissions")) {
          const channelId = String(this.values[0]);
          return Promise.resolve({
            results: this.admissions.has(channelId)
              ? [{ channel_id: channelId }]
              : [],
          });
        }
        const row = this.roots.get(this.rootKey());
        return Promise.resolve({ results: row === undefined ? [] : [row] });
      },
      bind: (...values: unknown[]) => {
        this.values = values;
        return this.prepare(sql);
      },
      run: () => {
        if (sql.includes("slack_progress_roots")) {
          if (sql.startsWith("DELETE")) {
            this.roots.delete(this.rootKey());
            return Promise.resolve({ meta: { changes: 1 } });
          }
          this.roots.set(this.rootKey(), {
            root_text: String(this.values[3]),
            root_ts: String(this.values[2]),
          });
          return Promise.resolve({ meta: { changes: 1 } });
        }
        const eventId = String(this.values[0]);
        if (sql.startsWith("INSERT INTO seen_events")) {
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

  private rootKey(): string {
    return `${String(this.values[0])}\u0000${String(this.values[1])}`;
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
  MODEL_BROKER: v.custom<ModelBrokerBinding>(
    (value): value is ModelBrokerBinding =>
      value !== null && typeof value === "object",
  ),
});

const testBindings = (db: FakeD1, secret?: string): SlackCoreBindings => {
  const base = {
    AI: {},
    DB: db,
    FLUE_SLACK_AGENT_AGENT: {},
    MODEL_BROKER: { fetch: () => Promise.resolve(new Response(null)) },
  };
  const bindings =
    secret === undefined ? base : { ...base, PROGRESS_BEARER: secret };
  if (!v.is(workerBindings, bindings)) {
    throw new Error("Invalid test bindings");
  }
  return bindings;
};

interface RecordedCall {
  readonly body: Record<string, string>;
  readonly method: string;
}

const slackRecorder =
  (calls: RecordedCall[], refusals: readonly (string | undefined)[] = []) =>
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = v.parse(v.string(), input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const attempt = calls.length;
    calls.push({
      body: v.parse(
        v.record(v.string(), v.string()),
        JSON.parse(v.parse(v.string(), init?.body)),
      ),
      method,
    });
    const refusal = refusals[attempt];
    return Promise.resolve(
      Response.json(
        refusal === undefined
          ? { ok: true, ts: "171.1" }
          : { error: refusal, ok: false },
      ),
    );
  };

const progressConfig = (): ResolvedSlackProgressConfig => {
  const { progress } = defineAgentConfig({
    description: "Reports task progress.",
    name: "Progress Agent",
    ownerInstructions: "Prefer short answers.",
    progress: {
      authSecret: "PROGRESS_BEARER",
      labels: {
        blocked: "Blocked",
        done: "Done",
        merged: "Merged",
        pr: "Pull request",
        progress: "In progress",
        review: "In review",
        started: "Started",
      },
    },
  });
  if (progress === undefined) {
    throw new Error("progress config is required");
  }
  return progress;
};

interface EndpointOverrides {
  readonly bearer?: string;
  readonly refusals?: readonly (string | undefined)[];
}

const endpointFor = (
  db: FakeD1,
  calls: RecordedCall[],
  overrides: EndpointOverrides = {},
) =>
  createSlackProgressEndpoint(progressConfig(), {
    bearer: overrides.bearer ?? BEARER,
    db: testBindings(db).DB,
    fetcher: slackRecorder(calls, overrides.refusals),
    token: trusted.botToken,
  });

interface Milestone {
  readonly channel: string;
  readonly id: string;
  readonly kind: string;
  readonly task: string;
  readonly text: string;
  readonly title: string;
  readonly url?: string;
}

const milestone: Milestone = {
  channel: "C1",
  id: "evt-1",
  kind: "started",
  task: "release-42",
  text: "Kicked off",
  title: "Release 42",
  url: "https://example.com/run",
};

const post = (
  body: string,
  authorization: string | null = `Bearer ${BEARER}`,
): Request =>
  new Request("https://example.com/progress", {
    body,
    headers: authorization === null ? {} : { authorization },
    method: "POST",
  });

const postMilestone = (
  overrides: Partial<Milestone> = {},
  authorization: string | null = `Bearer ${BEARER}`,
): Request =>
  post(JSON.stringify({ ...milestone, ...overrides }), authorization);

const authorizationRefusals = [null, "Bearer wrong", `Bearer ${BEARER}x`];

const rootCalls: RecordedCall[] = [
  {
    body: { channel: "C1", text: "Release 42 · Started" },
    method: "chat.postMessage",
  },
  {
    body: {
      channel: "C1",
      text: "Kicked off\nhttps://example.com/run",
      thread_ts: "171.1",
    },
    method: "chat.postMessage",
  },
];

describe("progress endpoint", () => {
  test("refuses a missing, wrong, or unconfigured bearer without calling Slack", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const bearerRefusals = await Promise.all(
      authorizationRefusals.map(async (authorization) => {
        const response = await endpoint.handle(
          postMilestone({}, authorization),
        );
        return { body: await response.json(), status: response.status };
      }),
    );

    expect(bearerRefusals).toEqual([
      { body: { error: "unauthorized", ok: false }, status: 401 },
      { body: { error: "unauthorized", ok: false }, status: 401 },
      { body: { error: "unauthorized", ok: false }, status: 401 },
    ]);

    const unconfigured = endpointFor(db, calls, { bearer: "" });
    const refused = await unconfigured.handle(
      post(JSON.stringify(milestone), "Bearer "),
    );

    expect(refused.status).toBe(401);
    expect(calls).toEqual([]);
    expect(db.seen.size).toBe(0);
  });

  test("refuses a body that is not a milestone without calling Slack", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const refused = [
      "not json",
      "{}",
      JSON.stringify({ ...milestone, channel: "" }),
      JSON.stringify({ ...milestone, kind: "shipped" }),
      JSON.stringify({ ...milestone, text: "" }),
      JSON.stringify({ ...milestone, title: "x".repeat(301) }),
      JSON.stringify({ ...milestone, text: "x".repeat(3901) }),
      JSON.stringify({ ...milestone, url: "http://example.com/run" }),
      JSON.stringify({ ...milestone, url: "not a url" }),
      JSON.stringify({
        ...milestone,
        url: `https://example.com/${"x".repeat(2048)}`,
      }),
      JSON.stringify({ channel: "C1", kind: "started" }),
    ];
    const refusedResults = await Promise.all(
      refused.map(async (body) => {
        const response = await endpoint.handle(post(body));
        return { body: await response.json(), status: response.status };
      }),
    );
    expect(refusedResults).toEqual(
      refused.map(() => ({
        body: { error: "invalid_request", ok: false },
        status: 400,
      })),
    );

    expect(calls).toEqual([]);
    expect(db.seen.size).toBe(0);
  });

  test("refuses a channel no allowlisted user invited the bot to", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const response = await endpoint.handle(postMilestone());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "channel_not_admitted",
      ok: false,
    });
    expect(calls).toEqual([]);
    expect(db.seen.size).toBe(0);
  });

  test("posts the root and the reply for the first milestone of a task", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const response = await endpoint.handle(postMilestone());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual(rootCalls);
    expect([...db.roots.values()]).toEqual([
      { root_text: "Release 42 · Started", root_ts: "171.1" },
    ]);
    expect([...db.seen]).toEqual(["progress:evt-1"]);
  });

  test("edits the root when the title or the label changes and replies to every milestone", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const started = await endpoint.handle(postMilestone());
    const changed = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "blocked",
        text: "Waiting on review",
      }),
    );
    const unchanged = await endpoint.handle(
      postMilestone({ id: "evt-3", kind: "blocked", text: "Still waiting" }),
    );
    const renamed = await endpoint.handle(
      postMilestone({
        id: "evt-4",
        kind: "blocked",
        text: "Still waiting",
        title: "Release 43",
      }),
    );

    expect([
      started.status,
      changed.status,
      unchanged.status,
      renamed.status,
    ]).toEqual([200, 200, 200, 200]);
    expect(calls).toEqual([
      ...rootCalls,
      {
        body: { channel: "C1", text: "Release 42 · Blocked", ts: "171.1" },
        method: "chat.update",
      },
      {
        body: {
          channel: "C1",
          text: "Waiting on review\nhttps://example.com/run",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Still waiting\nhttps://example.com/run",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
      {
        body: { channel: "C1", text: "Release 43 · Blocked", ts: "171.1" },
        method: "chat.update",
      },
      {
        body: {
          channel: "C1",
          text: "Still waiting\nhttps://example.com/run",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
    ]);
  });

  test("posts once when the same milestone id arrives twice", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const first = await endpoint.handle(postMilestone());
    const retried = await endpoint.handle(postMilestone());

    expect([first.status, retried.status]).toEqual([200, 200]);
    expect(await retried.json()).toEqual({ ok: true });
    expect(calls).toEqual(rootCalls);
  });

  test("answers non-2xx when Slack refuses the root, and lets the retry through", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const refusedCalls: RecordedCall[] = [];

    const refused = await endpointFor(db, refusedCalls, {
      refusals: ["channel_not_found"],
    }).handle(postMilestone());

    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: "slack_failed", ok: false });
    expect(refusedCalls).toEqual([rootCalls[0]]);
    expect(db.seen.size).toBe(0);

    const retriedCalls: RecordedCall[] = [];
    const retried = await endpointFor(db, retriedCalls).handle(postMilestone());

    expect(retried.status).toBe(200);
    expect(retriedCalls).toEqual(rootCalls);
  });

  test("replies to a stored root when Slack refuses the reply", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const refusedCalls: RecordedCall[] = [];

    const refused = await endpointFor(db, refusedCalls, {
      refusals: [undefined, "channel_not_found"],
    }).handle(postMilestone());

    expect(refused.status).toBe(500);
    expect(refusedCalls).toEqual(rootCalls);
    expect(db.seen.size).toBe(0);

    const retriedCalls: RecordedCall[] = [];
    const retried = await endpointFor(db, retriedCalls).handle(postMilestone());

    expect(retried.status).toBe(200);
    expect(retriedCalls).toEqual([rootCalls[1]]);
  });

  test("still replies when Slack refuses to edit the root", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      refusals: [undefined, undefined, "edit_window_closed"],
    });

    const started = await endpoint.handle(postMilestone());
    const blocked = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "blocked",
        text: "Waiting on review",
      }),
    );

    expect([started.status, blocked.status]).toEqual([200, 200]);
    expect(calls.at(-2)).toEqual({
      body: { channel: "C1", text: "Release 42 · Blocked", ts: "171.1" },
      method: "chat.update",
    });
    expect(calls.at(-1)).toEqual({
      body: {
        channel: "C1",
        text: "Waiting on review\nhttps://example.com/run",
        thread_ts: "171.1",
      },
      method: "chat.postMessage",
    });
    expect([...db.roots.values()]).toEqual([
      { root_text: "Release 42 · Started", root_ts: "171.1" },
    ]);
  });

  test("starts a new root when the stored one is gone", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      refusals: [undefined, undefined, "message_not_found"],
    });

    await endpoint.handle(postMilestone());
    const vanished = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "blocked",
        text: "Waiting on review",
      }),
    );
    const recovered = await endpoint.handle(
      postMilestone({ id: "evt-3", kind: "blocked", text: "Still waiting" }),
    );

    expect([vanished.status, recovered.status]).toEqual([200, 200]);
    expect(calls.at(-2)).toEqual({
      body: { channel: "C1", text: "Release 42 · Blocked" },
      method: "chat.postMessage",
    });
    expect(calls.at(-1)).toEqual({
      body: {
        channel: "C1",
        text: "Still waiting\nhttps://example.com/run",
        thread_ts: "171.1",
      },
      method: "chat.postMessage",
    });
    expect([...db.roots.values()]).toEqual([
      { root_text: "Release 42 · Blocked", root_ts: "171.1" },
    ]);
  });
});

describe("progress route", () => {
  test("serves no progress route when no endpoint is configured", async () => {
    const app = createApp(trusted, MODEL_PROVIDER_CLOUDFLARE, async () => {});

    const response = await app.request(
      "https://example.com/progress",
      { body: JSON.stringify(milestone), method: "POST" },
      testBindings(new FakeD1()),
    );

    expect(response.status).toBe(404);
  });

  test("serves the configured endpoint and reports its missing secret", async () => {
    const db = new FakeD1();
    db.admissions.add("C1");
    const calls: RecordedCall[] = [];
    const app = createApp(
      trusted,
      MODEL_PROVIDER_CLOUDFLARE,
      async () => {},
      undefined,
      undefined,
      undefined,
      endpointFor(db, calls),
    );

    const posted = await app.request(
      "https://example.com/progress",
      {
        body: JSON.stringify(milestone),
        headers: { authorization: `Bearer ${BEARER}` },
        method: "POST",
      },
      testBindings(db),
    );
    expect(posted.status).toBe(200);
    expect(calls).toEqual(rootCalls);

    const notReady = await app.request(
      "/health",
      undefined,
      testBindings(new FakeD1()),
    );
    expect(notReady.status).toBe(503);
    expect(JSON.parse(await notReady.text())).toEqual({
      missing: ["PROGRESS_BEARER"],
      status: "not_ready",
    });

    const ready = await app.request(
      "/health",
      undefined,
      testBindings(new FakeD1(), BEARER),
    );
    expect(ready.status).toBe(200);
    expect(JSON.parse(await ready.text())).toEqual({ status: "ready" });
  });
});
