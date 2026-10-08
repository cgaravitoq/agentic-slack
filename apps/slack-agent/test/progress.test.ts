import { describe, expect, spyOn, test } from "bun:test";
import {
  createSlackProgressEndpoint,
  defineAgentConfig,
  MODEL_PROVIDER_CLOUDFLARE,
} from "@agentic-slack/core";
import type {
  ModelBrokerBinding,
  SlackCoreBindings,
} from "@agentic-slack/core";
import type {
  ResolvedSlackProgressConfig,
  SlackProgressTurn,
} from "../../../packages/core/src/progress.ts";
import type { ConversationLifecycleAgent } from "../../../packages/core/src/retention.ts";
import * as v from "valibot";
import { createApp } from "../src/app.ts";
import { directoryUsers, slackDirectory } from "./slack-directory.ts";

const BEARER = "progress-bearer-for-tests";
const ADMITTED_BY = "U0ADMITSU";
const trusted = {
  appId: "A123",
  botToken: "xoxb-test",
  signingSecret: "signing-secret-for-tests-1234567890",
  teamId: "T123",
};

class FakeD1 {
  readonly admissions = new Map<string, string>();
  completeFailures = 0;
  readonly receipts = new Map<
    string,
    { claimed_at: number; state: string; ts: string | null; updated_at: number }
  >();
  readonly roots = new Map<
    string,
    { owned: number; root_text: string; root_ts: string; status: string | null }
  >();
  readonly seen = new Set<string>();
  private values: unknown[] = [];

  prepare(sql: string) {
    return {
      all: () => {
        if (sql.includes("slack_channel_admissions")) {
          if (!sql.includes("WHERE")) {
            return Promise.resolve({
              results: [...this.admissions.entries()]
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([channel_id, admitted_by]) => ({
                  admitted_by,
                  channel_id,
                })),
            });
          }
          const channelId = String(this.values[0]);
          const admittedBy = this.admissions.get(channelId);
          return Promise.resolve({
            results:
              admittedBy === undefined
                ? []
                : [{ admitted_by: admittedBy, channel_id: channelId }],
          });
        }
        if (sql.includes("progress_receipts")) {
          const row = this.receipts.get(String(this.values[0]));
          return Promise.resolve({ results: row === undefined ? [] : [row] });
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
          const status = v.safeParse(v.nullable(v.string()), this.values[5]);
          this.roots.set(this.rootKey(), {
            owned: Number(this.values[4]),
            root_text: String(this.values[3]),
            root_ts: String(this.values[2]),
            status: status.success ? status.output : null,
          });
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (sql.includes("progress_receipts")) {
          return this.runReceipt(sql);
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

  private runReceipt(sql: string): Promise<{ meta: { changes: number } }> {
    if (sql.startsWith("DELETE FROM progress_receipts WHERE rowid")) {
      const [cutoff, limit] = this.values.map(Number);
      const stale = [...this.receipts.entries()]
        .filter(([, row]) => row.updated_at < cutoff)
        .slice(0, limit);
      for (const [id] of stale) {
        this.receipts.delete(id);
      }
      return Promise.resolve({ meta: { changes: stale.length } });
    }
    const milestoneId = String(this.values[0]);
    if (sql.startsWith("DELETE FROM progress_receipts")) {
      this.receipts.delete(milestoneId);
      return Promise.resolve({ meta: { changes: 1 } });
    }
    if (sql.startsWith("UPDATE progress_receipts")) {
      const [, now, claimedAt] = this.values.map(Number);
      const row = this.receipts.get(milestoneId);
      if (
        row === undefined ||
        row.state !== "in_flight" ||
        row.claimed_at !== claimedAt
      ) {
        return Promise.resolve({ meta: { changes: 0 } });
      }
      this.receipts.set(milestoneId, {
        ...row,
        claimed_at: now,
        updated_at: now,
      });
      return Promise.resolve({ meta: { changes: 1 } });
    }
    const now = Number(this.values[3]);
    if (sql.includes("DO NOTHING")) {
      const claimedAt = Number(this.values[1]);
      if (this.receipts.has(milestoneId)) {
        return Promise.resolve({ meta: { changes: 0 } });
      }
      this.receipts.set(milestoneId, {
        claimed_at: claimedAt,
        state: "in_flight",
        ts: null,
        updated_at: claimedAt,
      });
      return Promise.resolve({ meta: { changes: 1 } });
    }
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      return Promise.reject(new Error("receipt completion failed"));
    }
    const state = v.parse(v.string(), this.values[1]);
    const ts = v.parse(v.nullable(v.string()), this.values[2]);
    this.receipts.set(milestoneId, {
      claimed_at: this.receipts.get(milestoneId)?.claimed_at ?? now,
      state,
      ts,
      updated_at: now,
    });
    return Promise.resolve({ meta: { changes: 1 } });
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

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// workerd rejects a built-in fetch invoked with a receiver, while Bun ignores
// the receiver, so only a strict wrapper lets a test observe the difference.
const strictFetch = (delegate: Fetcher): Fetcher =>
  function rejectReceiver(this: undefined, input, init) {
    if (this !== undefined) {
      throw new Error(
        "Illegal invocation: function called with incorrect `this` reference",
      );
    }
    return delegate(input, init);
  };

interface ChannelInfo {
  readonly is_mpim?: boolean;
  readonly is_private?: boolean;
  readonly name?: string;
}

const callBody = (init: RequestInit | undefined): Record<string, string> => {
  const raw = init?.body;
  if (raw instanceof URLSearchParams) {
    return Object.fromEntries(raw);
  }
  return v.parse(
    v.record(v.string(), v.string()),
    JSON.parse(v.parse(v.string(), raw)),
  );
};

const slackRecorder =
  (
    calls: RecordedCall[],
    refusals: readonly (string | undefined)[] = [],
    infos: Readonly<Record<string, ChannelInfo>> = {},
  ) =>
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = v.parse(v.string(), input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const attempt = calls.length;
    const form = init?.body instanceof URLSearchParams;
    const body = callBody(init);
    calls.push({ body, method });
    if (method === "conversations.info") {
      // Slack refuses a JSON body on a read method, as it did live on
      // right-hand-staging before progress.ts sent this one form-encoded.
      if (!form) {
        return Promise.resolve(
          Response.json({ error: "invalid_arguments", ok: false }),
        );
      }
      const info = infos[body.channel];
      return Promise.resolve(
        Response.json(
          info === undefined
            ? { error: "channel_not_found", ok: false }
            : { channel: info, ok: true },
        ),
      );
    }
    const refusal = refusals[attempt];
    return Promise.resolve(
      Response.json(
        refusal === undefined
          ? { ok: true, ts: "171.1" }
          : { error: refusal, ok: false },
      ),
    );
  };

const progressConfig = (narration?: string): ResolvedSlackProgressConfig => {
  const labels = {
    blocked: "Blocked",
    done: "Done",
    merged: "Merged",
    pr: "Pull request",
    progress: "In progress",
    review: "In review",
    started: "Started",
  };
  const { progress } = defineAgentConfig({
    description: "Reports task progress.",
    name: "Progress Agent",
    ownerInstructions: "Prefer short answers.",
    progress:
      narration === undefined
        ? { authSecret: "PROGRESS_BEARER", labels }
        : { authSecret: "PROGRESS_BEARER", labels, narration },
  });
  if (progress === undefined) {
    throw new Error("progress config is required");
  }
  return progress;
};

interface EndpointOverrides {
  readonly bearer?: string;
  readonly fetcher?: Fetcher;
  readonly infos?: Readonly<Record<string, ChannelInfo>>;
  readonly narration?: string;
  readonly narrate?: (turn: SlackProgressTurn) => Promise<void>;
  readonly refusals?: readonly (string | undefined)[];
}

const endpointFor = (
  db: FakeD1,
  calls: RecordedCall[],
  overrides: EndpointOverrides = {},
) =>
  createSlackProgressEndpoint(progressConfig(overrides.narration), {
    bearer: overrides.bearer ?? BEARER,
    db: testBindings(db).DB,
    fetcher:
      overrides.fetcher ??
      slackRecorder(calls, overrides.refusals, overrides.infos),
    narrate: overrides.narrate ?? (() => Promise.resolve()),
    teamId: trusted.teamId,
    token: trusted.botToken,
  });

interface Milestone {
  readonly channel: string;
  readonly id: string;
  readonly kind: string;
  readonly mentions?: readonly string[];
  readonly status?: string;
  readonly task: string;
  readonly text: string | undefined;
  readonly threadTs?: string;
  readonly title: string;
  readonly url?: string;
  readonly verbatim?: boolean;
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

const getChannels = (
  authorization: string | null = `Bearer ${BEARER}`,
): Request =>
  new Request("https://example.com/progress/channels", {
    headers: authorization === null ? {} : { authorization },
  });

const authorizationRefusals = [null, "Bearer wrong", `Bearer ${BEARER}x`];

const rootCalls: RecordedCall[] = [
  {
    body: { channel: "C1", text: "Release 42 · Started" },
    method: "chat.postMessage",
  },
  {
    body: {
      channel: "C1",
      text: "Kicked off\n<https://example.com/run>",
      thread_ts: "171.1",
    },
    method: "chat.postMessage",
  },
];

const narrations = () => {
  const turns: SlackProgressTurn[] = [];
  return {
    narrate: (turn: SlackProgressTurn): Promise<void> => {
      turns.push(turn);
      return Promise.resolve();
    },
    turns,
  };
};

describe("progress endpoint", () => {
  test("refuses a missing, wrong, or unconfigured bearer without calling Slack", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
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
    expect(db.receipts.size).toBe(0);
  });

  test("refuses a body that is not a milestone without calling Slack", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const refused = [
      "not json",
      "{}",
      JSON.stringify({ ...milestone, channel: "" }),
      JSON.stringify({ ...milestone, channel: "x".repeat(256) }),
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
      JSON.stringify({ ...milestone, mentions: "juan" }),
      JSON.stringify({ ...milestone, mentions: [""] }),
      JSON.stringify({ ...milestone, mentions: ["x".repeat(101)] }),
      JSON.stringify({
        ...milestone,
        mentions: Array.from({ length: 11 }, () => "juan"),
      }),
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
    expect(db.receipts.size).toBe(0);
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
    expect(db.receipts.size).toBe(0);
  });

  test("posts to the channel an admitted name resolves to, with or without # and in any case", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(
        slackRecorder(calls, [], { C1: { name: "Sandbox" } }),
      ),
    });

    const named = await endpoint.handle(postMilestone({ channel: "sandbox" }));
    const hashed = await endpoint.handle(
      postMilestone({ channel: "#SANDBOX", id: "evt-2" }),
    );
    const cased = await endpoint.handle(
      postMilestone({ channel: "SaNdBoX", id: "evt-3" }),
    );

    expect([named.status, hashed.status, cased.status]).toEqual([
      200, 200, 200,
    ]);
    expect(calls).toEqual([
      { body: { channel: "C1" }, method: "conversations.info" },
      ...rootCalls,
      { body: { channel: "C1" }, method: "conversations.info" },
      {
        body: {
          channel: "C1",
          text: "Kicked off\n<https://example.com/run>",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
      { body: { channel: "C1" }, method: "conversations.info" },
      {
        body: {
          channel: "C1",
          text: "Kicked off\n<https://example.com/run>",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
    ]);
  });

  test("keys the root and the narration by the resolved id", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const { narrate, turns } = narrations();
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(
        slackRecorder(calls, [], { C1: { is_private: true, name: "secret" } }),
      ),
      narrate,
      narration: "Write in Spanish, warm and brief.",
    });

    const byName = await endpoint.handle(postMilestone({ channel: "#secret" }));
    const byId = await endpoint.handle(
      postMilestone({ channel: "C1", id: "evt-2" }),
    );

    expect([byName.status, byId.status]).toEqual([200, 200]);
    expect(calls).toEqual([
      { body: { channel: "C1" }, method: "conversations.info" },
      {
        body: { channel: "C1", text: "Release 42 · Started" },
        method: "chat.postMessage",
      },
    ]);
    expect([...db.roots.values()]).toEqual([
      {
        owned: 1,
        root_text: "Release 42 · Started",
        root_ts: "171.1",
        status: null,
      },
    ]);
    expect(
      turns.map((turn) => [turn.binding.channelId, turn.instanceId]),
    ).toEqual([
      ["C1", "slack:v1:T123:C1:171.1"],
      ["C1", "slack:v1:T123:C1:171.1"],
    ]);
  });

  test("refuses a name that matches no admitted channel and an id that is not admitted", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(
        slackRecorder(calls, [], { C1: { name: "Sandbox" } }),
      ),
    });

    const unknown = await endpoint.handle(
      postMilestone({ channel: "release" }),
    );
    const foreign = await endpoint.handle(
      postMilestone({ channel: "C9", id: "evt-2" }),
    );

    expect([unknown.status, foreign.status]).toEqual([403, 403]);
    expect(await unknown.json()).toEqual({
      error: "channel_not_admitted",
      ok: false,
    });
    expect(await foreign.json()).toEqual({
      error: "channel_not_admitted",
      ok: false,
    });
    expect(calls).toEqual([
      { body: { channel: "C1" }, method: "conversations.info" },
      { body: { channel: "C1" }, method: "conversations.info" },
    ]);
    expect(db.roots.size).toBe(0);
    expect(db.receipts.size).toBe(0);
  });

  test("refuses a name that matches several admitted channels", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    db.admissions.set("C2", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(
        slackRecorder(calls, [], {
          C1: { name: "Sandbox" },
          C2: { name: "sandbox" },
        }),
      ),
    });

    const response = await endpoint.handle(
      postMilestone({ channel: "sandbox" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "ambiguous_channel",
      ok: false,
    });
    expect(calls).toEqual([
      { body: { channel: "C1" }, method: "conversations.info" },
      { body: { channel: "C2" }, method: "conversations.info" },
    ]);
    expect(db.roots.size).toBe(0);
    expect(db.receipts.size).toBe(0);
  });

  test("lists every admitted channel, naming the one Slack refuses to describe", async () => {
    const db = new FakeD1();
    for (const channelId of ["C1", "C2", "C3", "C9", "G1"]) {
      db.admissions.set(channelId, ADMITTED_BY);
    }
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(
        slackRecorder(calls, [], {
          C1: { name: "sandbox" },
          C2: { is_mpim: true, name: "mpdm-ana--bo-1" },
          C3: { is_private: true, name: "secret" },
          G1: { is_private: true, name: "archive" },
        }),
      ),
    });

    const response = await endpoint.handleChannels(getChannels());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channels: [
        { id: "C1", kind: "channel", name: "sandbox" },
        { id: "C2", kind: "group", name: "mpdm-ana--bo-1" },
        { id: "C3", kind: "private", name: "secret" },
        { id: "C9", kind: "channel", name: null },
        { id: "G1", kind: "private", name: "archive" },
      ],
      ok: true,
    });
    expect(calls).toEqual(
      ["C1", "C2", "C3", "C9", "G1"].map((channel) => ({
        body: { channel },
        method: "conversations.info",
      })),
    );
  });

  test("guards the channel listing with the same bearer", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const refusals = await Promise.all(
      authorizationRefusals.map(async (authorization) => {
        const response = await endpoint.handleChannels(
          getChannels(authorization),
        );
        return { body: await response.json(), status: response.status };
      }),
    );

    expect(refusals).toEqual(
      authorizationRefusals.map(() => ({
        body: { error: "unauthorized", ok: false },
        status: 401,
      })),
    );
    expect(calls).toEqual([]);
  });

  test("posts the root and the reply for the first milestone of a task", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const response = await endpoint.handle(postMilestone());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls).toEqual(rootCalls);
    expect([...db.roots.values()]).toEqual([
      {
        owned: 1,
        root_text: "Release 42 · Started",
        root_ts: "171.1",
        status: null,
      },
    ]);
    expect(db.receipts.get("evt-1")).toMatchObject({
      state: "posted",
      ts: "171.1",
    });
    expect(db.receipts.size).toBe(1);
  });

  test("posts the root and the reply through an injected fetcher that rejects a receiver", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(slackRecorder(calls)),
    });

    const response = await endpoint.handle(postMilestone());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls).toEqual(rootCalls);
  });

  test("posts the root and the reply through the default global fetch that rejects a receiver", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const network = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(strictFetch(slackRecorder(calls)), {
        preconnect: fetch.preconnect,
      }),
    );
    try {
      const endpoint = createSlackProgressEndpoint(progressConfig(), {
        bearer: BEARER,
        db: testBindings(db).DB,
        narrate: () => Promise.resolve(),
        teamId: trusted.teamId,
        token: trusted.botToken,
      });

      const response = await endpoint.handle(postMilestone());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ts: "171.1" });
      expect(calls).toEqual(rootCalls);
    } finally {
      network.mockRestore();
    }
  });

  test("edits the root when the title or the label changes and replies to every milestone", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
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
          text: "Waiting on review\n<https://example.com/run>",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Still waiting\n<https://example.com/run>",
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
          text: "Still waiting\n<https://example.com/run>",
          thread_ts: "171.1",
        },
        method: "chat.postMessage",
      },
    ]);
  });

  test("posts once when the same milestone id arrives twice", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const first = await endpoint.handle(postMilestone());
    const retried = await endpoint.handle(postMilestone());

    expect([first.status, retried.status]).toEqual([200, 200]);
    expect(await retried.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls).toEqual(rootCalls);
  });

  test("answers a milestone it already posted with the stored timestamp", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const first = await endpoint.handle(postMilestone());
    db.receipts.set("evt-1", {
      claimed_at: 1,
      state: "posted",
      ts: "999.001",
      updated_at: 1,
    });

    const retried = await endpoint.handle(postMilestone());

    expect(await first.json()).toEqual({ ok: true, ts: "171.1" });
    expect(await retried.json()).toEqual({ ok: true, ts: "999.001" });
    expect(calls).toEqual(rootCalls);
  });

  test("answers a posted duplicate sent by channel name without calling Slack", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls, {
      fetcher: strictFetch(
        slackRecorder(calls, [], { C1: { name: "Sandbox" } }),
      ),
    });

    const first = await endpoint.handle(postMilestone());
    const retried = await endpoint.handle(
      postMilestone({ channel: "#SANDBOX" }),
    );

    expect(await first.json()).toEqual({ ok: true, ts: "171.1" });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls).toEqual(rootCalls);
  });

  test("refuses a milestone whose receipt is still in flight", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);
    const now = Math.floor(Date.now() / 1000);
    db.receipts.set("evt-1", {
      claimed_at: now,
      state: "in_flight",
      ts: null,
      updated_at: now,
    });

    const response = await endpoint.handle(postMilestone());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "in_flight", ok: false });
    expect(calls).toEqual([]);
  });

  test("reclaims a receipt left in flight past its lease and posts once", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);
    const stale = Math.floor(Date.now() / 1000) - 301;
    db.receipts.set("evt-1", {
      claimed_at: stale,
      state: "in_flight",
      ts: null,
      updated_at: stale,
    });

    const response = await endpoint.handle(postMilestone());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls).toEqual(rootCalls);
    expect(db.receipts.get("evt-1")).toMatchObject({
      state: "posted",
      ts: "171.1",
    });
  });

  test("retries a receipt write that fails after the post and never posts the milestone twice", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);
    db.completeFailures = 1;

    const first = await endpoint.handle(postMilestone());

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, ts: "171.1" });
    expect(db.receipts.get("evt-1")).toMatchObject({
      state: "posted",
      ts: "171.1",
    });

    const stored = db.receipts.get("evt-1");
    if (stored === undefined) {
      throw new Error("the post left no receipt");
    }
    const stale = Math.floor(Date.now() / 1000) - 301;
    db.receipts.set("evt-1", {
      claimed_at: stale,
      state: stored.state,
      ts: stored.ts,
      updated_at: stale,
    });

    const retried = await endpoint.handle(postMilestone());

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls).toEqual(rootCalls);
  });

  test("settles the receipt when every completion write fails, so a retry does not repost", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);
    db.completeFailures = 2;

    const first = await endpoint.handle(postMilestone());

    expect(first.status).toBe(500);
    expect(db.receipts.get("evt-1")).toMatchObject({ state: "narrated" });

    const retried = await endpoint.handle(postMilestone());

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ narrated: true, ok: true });
    expect(calls).toEqual(rootCalls);
  });

  test("adopts the thread a milestone names and posts no root of its own", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    const adopted = await endpoint.handle(
      postMilestone({ threadTs: "555.000" }),
    );
    const later = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "blocked",
        text: "Waiting on review",
        threadTs: "555.000",
      }),
    );

    expect([adopted.status, later.status]).toEqual([200, 200]);
    expect(await adopted.json()).toEqual({ ok: true, ts: "171.1" });
    expect(calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "chat.postMessage",
    ]);
    expect(calls.map((call) => call.body.thread_ts)).toEqual([
      "555.000",
      "555.000",
    ]);
    expect([...db.roots.values()]).toEqual([
      {
        owned: 0,
        root_text: "Release 42 · Started",
        root_ts: "555.000",
        status: null,
      },
    ]);
  });

  test("leaves the text of a thread it does not own alone when the label changes", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    await endpoint.handle(postMilestone({ threadTs: "555.000" }));
    const blocked = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "blocked",
        text: "Waiting on review",
        threadTs: "555.000",
      }),
    );
    const renamed = await endpoint.handle(
      postMilestone({
        id: "evt-3",
        task: "release-43",
        threadTs: "555.000",
      }),
    );

    expect([blocked.status, renamed.status]).toEqual([200, 200]);
    expect(calls.map((call) => call.method)).not.toContain("chat.update");
    expect([...db.roots.values()]).toEqual([
      {
        owned: 0,
        root_text: "Release 42 · Started",
        root_ts: "555.000",
        status: null,
      },
      {
        owned: 0,
        root_text: "Release 42 · Started",
        root_ts: "555.000",
        status: null,
      },
    ]);
  });

  test("refuses a thread that is not the one it holds", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = endpointFor(db, calls);

    await endpoint.handle(postMilestone({ threadTs: "555.000" }));
    const owned = await endpoint.handle(
      postMilestone({ id: "evt-2", task: "release-43" }),
    );
    const unowned = await endpoint.handle(
      postMilestone({ id: "evt-3", threadTs: "666.000" }),
    );
    const ownedMismatch = await endpoint.handle(
      postMilestone({ id: "evt-4", task: "release-43", threadTs: "666.000" }),
    );

    expect([owned.status, unowned.status, ownedMismatch.status]).toEqual([
      200, 409, 409,
    ]);
    expect(await unowned.json()).toEqual({
      error: "thread_mismatch",
      ok: false,
    });
    expect(await ownedMismatch.json()).toEqual({
      error: "thread_mismatch",
      ok: false,
    });
    expect(db.receipts.has("evt-3")).toBe(false);
    expect(db.receipts.has("evt-4")).toBe(false);
  });

  test("answers non-2xx when Slack refuses the root, and lets the retry through", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const refusedCalls: RecordedCall[] = [];

    const refused = await endpointFor(db, refusedCalls, {
      refusals: ["channel_not_found"],
    }).handle(postMilestone());

    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: "slack_failed", ok: false });
    expect(refusedCalls).toEqual([rootCalls[0]]);
    expect(db.receipts.has("evt-1")).toBe(false);

    const retriedCalls: RecordedCall[] = [];
    const retried = await endpointFor(db, retriedCalls).handle(postMilestone());

    expect(retried.status).toBe(200);
    expect(retriedCalls).toEqual(rootCalls);
  });

  test("replies to a stored root when Slack refuses the reply", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const refusedCalls: RecordedCall[] = [];

    const refused = await endpointFor(db, refusedCalls, {
      refusals: [undefined, "channel_not_found"],
    }).handle(postMilestone());

    expect(refused.status).toBe(500);
    expect(refusedCalls).toEqual(rootCalls);
    expect(db.receipts.has("evt-1")).toBe(false);

    const retriedCalls: RecordedCall[] = [];
    const retried = await endpointFor(db, retriedCalls).handle(postMilestone());

    expect(retried.status).toBe(200);
    expect(retriedCalls).toEqual([rootCalls[1]]);
  });

  test("still replies when Slack refuses to edit the root", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
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
        text: "Waiting on review\n<https://example.com/run>",
        thread_ts: "171.1",
      },
      method: "chat.postMessage",
    });
    expect([...db.roots.values()]).toEqual([
      {
        owned: 1,
        root_text: "Release 42 · Started",
        root_ts: "171.1",
        status: null,
      },
    ]);
  });

  test("starts a new root when the stored one is gone", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
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
        text: "Still waiting\n<https://example.com/run>",
        thread_ts: "171.1",
      },
      method: "chat.postMessage",
    });
    expect([...db.roots.values()]).toEqual([
      {
        owned: 1,
        root_text: "Release 42 · Blocked",
        root_ts: "171.1",
        status: null,
      },
    ]);
  });
});

const ROOT_TS = "171.1";
const REPLY_TS = "171.2";

describe("progress root status", () => {
  const statusRecorder =
    (
      calls: RecordedCall[],
      refusals: readonly (string | undefined)[] = [],
    ): Fetcher =>
    (input, init) => {
      const url = v.parse(v.string(), input);
      const method = url.slice(url.lastIndexOf("/") + 1);
      const attempt = calls.length;
      const body = callBody(init);
      calls.push({ body, method });
      const refusal = refusals[attempt];
      if (refusal !== undefined) {
        return Promise.resolve(Response.json({ error: refusal, ok: false }));
      }
      // Slack answers the root and each reply with its own ts, so a test can
      // tell the root's receipt from the reply's.
      return Promise.resolve(
        Response.json({
          ok: true,
          ts: body.thread_ts === undefined ? ROOT_TS : REPLY_TS,
        }),
      );
    };

  const statusEndpoint = (
    db: FakeD1,
    calls: RecordedCall[],
    refusals: readonly (string | undefined)[] = [],
  ) => {
    db.admissions.set("C1", ADMITTED_BY);
    return endpointFor(db, calls, {
      fetcher: strictFetch(statusRecorder(calls, refusals)),
    });
  };

  const rootStatus = (
    status: string,
    overrides: Partial<Milestone> = {},
  ): Request => postMilestone({ ...overrides, status, text: undefined });

  test("edits the owned root for a root-only milestone and answers that root without a reply", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = statusEndpoint(db, calls);

    const started = await endpoint.handle(postMilestone());
    const status = await endpoint.handle(
      rootStatus("2 of 5 landed", { id: "evt-2" }),
    );

    expect(await started.json()).toEqual({ ok: true, ts: REPLY_TS });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ ok: true, ts: ROOT_TS });
    expect(calls).toEqual([
      {
        body: { channel: "C1", text: "Release 42 · Started" },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Kicked off\n<https://example.com/run>",
          thread_ts: ROOT_TS,
        },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Release 42 · Started · 2 of 5 landed",
          ts: ROOT_TS,
        },
        method: "chat.update",
      },
    ]);
    expect(db.roots.get("C1\u0000release-42")).toEqual({
      owned: 1,
      root_text: "Release 42 · Started · 2 of 5 landed",
      root_ts: ROOT_TS,
      status: "2 of 5 landed",
    });
    expect(db.receipts.get("evt-2")).toMatchObject({
      state: "posted",
      ts: ROOT_TS,
    });
  });

  test("answers the replay of a root-only milestone from its receipt without a Slack call", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = statusEndpoint(db, calls);

    await endpoint.handle(postMilestone());
    const first = await endpoint.handle(rootStatus("Halfway", { id: "evt-2" }));
    const retryCalls: RecordedCall[] = [];
    const retried = await endpointFor(db, retryCalls, {
      fetcher: strictFetch(statusRecorder(retryCalls)),
    }).handle(rootStatus("Halfway", { id: "evt-2" }));

    expect(await first.json()).toEqual({ ok: true, ts: ROOT_TS });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, ts: ROOT_TS });
    expect(retryCalls).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  test("renders the stored status on a later milestone that sends none", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = statusEndpoint(db, calls);

    const first = await endpoint.handle(rootStatus("2 of 5 landed"));
    const later = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "blocked",
        text: "Waiting on review",
      }),
    );

    expect(await first.json()).toEqual({ ok: true, ts: ROOT_TS });
    expect(await later.json()).toEqual({ ok: true, ts: REPLY_TS });
    expect(calls).toEqual([
      {
        body: {
          channel: "C1",
          text: "Release 42 · Started · 2 of 5 landed",
        },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Release 42 · Blocked · 2 of 5 landed",
          ts: ROOT_TS,
        },
        method: "chat.update",
      },
      {
        body: {
          channel: "C1",
          text: "Waiting on review\n<https://example.com/run>",
          thread_ts: ROOT_TS,
        },
        method: "chat.postMessage",
      },
    ]);
  });

  test("updates the root before replying when a milestone carries a status and text", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = statusEndpoint(db, calls);

    await endpoint.handle(postMilestone());
    const both = await endpoint.handle(
      postMilestone({
        id: "evt-2",
        kind: "pr",
        status: "1 of 5 landed",
        text: "Opened the pull request",
      }),
    );

    expect(await both.json()).toEqual({ ok: true, ts: REPLY_TS });
    expect(calls.map((call) => call.method)).toEqual([
      "chat.postMessage",
      "chat.postMessage",
      "chat.update",
      "chat.postMessage",
    ]);
    expect(calls[2]).toEqual({
      body: {
        channel: "C1",
        text: "Release 42 · Pull request · 1 of 5 landed",
        ts: ROOT_TS,
      },
      method: "chat.update",
    });
    expect(db.receipts.get("evt-2")).toMatchObject({
      state: "posted",
      ts: REPLY_TS,
    });
  });

  test("stores the status of a root-only milestone on a thread it does not own and leaves it alone", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = statusEndpoint(db, calls);

    await endpoint.handle(postMilestone({ threadTs: "555.000" }));
    const status = await endpoint.handle(
      rootStatus("2 of 5 landed", { id: "evt-2", threadTs: "555.000" }),
    );
    const later = await endpoint.handle(
      postMilestone({
        id: "evt-3",
        kind: "blocked",
        text: "Waiting on review",
        threadTs: "555.000",
      }),
    );

    expect(await status.json()).toEqual({ ok: true, ts: "555.000" });
    expect(await later.json()).toEqual({ ok: true, ts: REPLY_TS });
    expect(calls.map((call) => call.method)).not.toContain("chat.update");
    expect(calls.filter((call) => call.body.thread_ts === "555.000")).toEqual([
      {
        body: {
          channel: "C1",
          text: "Kicked off\n<https://example.com/run>",
          thread_ts: "555.000",
        },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Waiting on review\n<https://example.com/run>",
          thread_ts: "555.000",
        },
        method: "chat.postMessage",
      },
    ]);
    expect(db.roots.get("C1\u0000release-42")).toEqual({
      owned: 0,
      root_text: "Release 42 · Started",
      root_ts: "555.000",
      status: "2 of 5 landed",
    });
    expect(db.receipts.get("evt-2")).toMatchObject({
      state: "posted",
      ts: "555.000",
    });
  });

  test("refuses a status longer than 300 characters after redaction without clamping it", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const endpoint = statusEndpoint(db, calls);

    const refused = await endpoint.handle(rootStatus("x".repeat(301)));
    const boundary = await endpoint.handle(
      rootStatus("x".repeat(300), { id: "evt-2" }),
    );
    const redacted = await endpoint.handle(
      rootStatus(`xoxb-${"x".repeat(400)}`, { id: "evt-3" }),
    );

    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "status_too_long",
      ok: false,
    });
    expect(db.receipts.has("evt-1")).toBe(false);
    expect(boundary.status).toBe(200);
    expect(redacted.status).toBe(200);
    expect(calls).toEqual([
      {
        body: {
          channel: "C1",
          text: `Release 42 · Started · ${"x".repeat(300)}`,
        },
        method: "chat.postMessage",
      },
      {
        body: {
          channel: "C1",
          text: "Release 42 · Started · [secret]",
          ts: ROOT_TS,
        },
        method: "chat.update",
      },
    ]);
  });

  test("answers 500 when Slack refuses the root edit a root-only milestone is, and lets the retry through", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    await statusEndpoint(db, calls).handle(postMilestone());

    const refusedCalls: RecordedCall[] = [];
    const refused = await statusEndpoint(db, refusedCalls, [
      "edit_window_closed",
    ]).handle(rootStatus("Halfway", { id: "evt-2" }));

    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ error: "slack_failed", ok: false });
    expect(refusedCalls.map((call) => call.method)).toEqual(["chat.update"]);
    expect(db.receipts.has("evt-2")).toBe(false);
    expect(db.roots.get("C1\u0000release-42")?.root_text).toBe(
      "Release 42 · Started",
    );

    const retriedCalls: RecordedCall[] = [];
    const retried = await statusEndpoint(db, retriedCalls).handle(
      rootStatus("Halfway", { id: "evt-2" }),
    );

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, ts: ROOT_TS });
    expect(retriedCalls).toEqual([
      {
        body: {
          channel: "C1",
          text: "Release 42 · Started · Halfway",
          ts: ROOT_TS,
        },
        method: "chat.update",
      },
    ]);
    expect(db.roots.get("C1\u0000release-42")?.status).toBe("Halfway");
  });
});

describe("narrated progress endpoint", () => {
  test("keeps posting the curated reply when no narration is configured", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const { narrate, turns } = narrations();

    const response = await endpointFor(db, calls, { narrate }).handle(
      postMilestone(),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(rootCalls);
    expect(turns).toEqual([]);
  });

  test("posts a verbatim milestone as given and never narrates it", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const { narrate, turns } = narrations();

    const response = await endpointFor(db, calls, {
      narrate,
      narration: "Write in Spanish, warm and brief.",
    }).handle(postMilestone({ threadTs: "555.000", verbatim: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ts: "171.1" });
    expect(turns).toEqual([]);
    expect(calls).toEqual([
      {
        body: {
          channel: "C1",
          text: "Kicked off\n<https://example.com/run>",
          thread_ts: "555.000",
        },
        method: "chat.postMessage",
      },
    ]);
    expect(db.receipts.get("evt-1")).toMatchObject({
      state: "posted",
      ts: "171.1",
    });
  });

  test("redacts what a verbatim milestone would carry", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];

    const response = await endpointFor(db, calls).handle(
      postMilestone({
        text: "Bearer xoxb-1234-not-a-real-token",
        threadTs: "555.000",
        verbatim: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0]?.body.text).toBe(
      "Bearer [secret]\n<https://example.com/run>",
    );
  });

  test("narrates a milestone as one turn in its thread and posts no reply itself", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const { narrate, turns } = narrations();

    const response = await endpointFor(db, calls, {
      narrate,
      narration: "Write in Spanish, warm and brief.",
    }).handle(postMilestone());

    expect(response.status).toBe(200);
    expect(calls).toEqual([rootCalls[0]]);
    expect(turns).toEqual([
      {
        binding: {
          channelId: "C1",
          fallbackText: "Kicked off",
          links: "https://example.com/run",
          recipientTeamId: "T123",
          recipientUserId: ADMITTED_BY,
          surface: "channel",
          taskUpdates: "hidden",
          threadTs: "171.1",
        },
        body: [
          "Write in Spanish, warm and brief.",
          "Task: release-42",
          "Status: Started",
          "Milestone: Kicked off",
          "Trusted code closes your reply by linking https://example.com/run, so do not write the tags or the link yourself.",
          "Rewrite this milestone as your reply in that voice: one or two short sentences that use the earlier milestones in this thread as context and say only what this milestone and those earlier milestones say.",
        ].join("\n\n"),
        instanceId: "slack:v1:T123:C1:171.1",
        milestoneId: "evt-1",
      },
    ]);
  });

  test("posts the curated reply when the narration turn cannot start", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];

    const response = await endpointFor(db, calls, {
      narrate: () => Promise.reject(new Error("agent unavailable")),
      narration: "Write in Spanish, warm and brief.",
    }).handle(postMilestone());

    expect(response.status).toBe(200);
    expect(calls).toEqual(rootCalls);
  });

  test("narrates once when the same milestone id arrives twice", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const { narrate, turns } = narrations();
    const endpoint = endpointFor(db, calls, {
      narrate,
      narration: "Write in Spanish, warm and brief.",
    });

    const first = await endpoint.handle(postMilestone());
    const retried = await endpoint.handle(postMilestone());

    expect([first.status, retried.status]).toEqual([200, 200]);
    expect(await retried.json()).toEqual({ narrated: true, ok: true });
    expect(calls).toEqual([rootCalls[0]]);
    expect(turns).toHaveLength(1);
  });
});

describe("progress mentions", () => {
  const taggedReply = {
    body: {
      channel: "C1",
      text: "Kicked off\n<@U0JUAN> <@U0ANA> <https://example.com/run>",
      thread_ts: "171.1",
    },
    method: "chat.postMessage",
  };
  const directoryEndpoint = (
    db: FakeD1,
    calls: RecordedCall[],
    overrides: EndpointOverrides = {},
  ) =>
    endpointFor(db, calls, {
      ...overrides,
      fetcher: strictFetch(
        slackDirectory(
          { C1: ["U0JUAN", "U0ANA", "U0JUANR"] },
          directoryUsers,
          slackRecorder(calls),
        ),
      ),
    });

  test("closes the curated reply with the members a milestone tags and its link", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];

    const response = await directoryEndpoint(db, calls).handle(
      postMilestone({ mentions: ["Juan Pérez", "<@U0ANA>"] }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([rootCalls[0], taggedReply]);
  });

  test("hands a narration the members it tags and its link", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const { narrate, turns } = narrations();

    const response = await directoryEndpoint(db, calls, {
      narrate,
      narration: "Write in Spanish, warm and brief.",
    }).handle(postMilestone({ mentions: ["Juan Pérez", "ana.r"] }));

    expect(response.status).toBe(200);
    expect(calls).toEqual([rootCalls[0]]);
    expect(turns.map((turn) => turn.binding)).toEqual([
      {
        channelId: "C1",
        fallbackText: "Kicked off",
        links: "https://example.com/run",
        mentions: "U0JUAN U0ANA",
        recipientTeamId: "T123",
        recipientUserId: ADMITTED_BY,
        surface: "channel",
        taskUpdates: "hidden",
        threadTs: "171.1",
      },
    ]);
    expect(turns[0]?.body).toContain(
      "Milestone: Kicked off\n\nTrusted code closes your reply by tagging Juan Pérez, ana.r and linking https://example.com/run, so do not write the tags or the link yourself.",
    );
  });

  test("posts the tags and the link itself when the narration turn cannot start", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];

    const response = await directoryEndpoint(db, calls, {
      narrate: () => Promise.reject(new Error("agent unavailable")),
      narration: "Write in Spanish, warm and brief.",
    }).handle(postMilestone({ mentions: ["Juan Pérez", "ana.r"] }));

    expect(response.status).toBe(200);
    expect(calls).toEqual([rootCalls[0], taggedReply]);
  });

  test("answers a retry of a tagged milestone from its receipt without reading the directory", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const retryCalls: RecordedCall[] = [];
    const tagged = () => postMilestone({ mentions: ["Juan Pérez", "ana.r"] });

    const first = await directoryEndpoint(db, calls).handle(tagged());
    const retried = await endpointFor(db, retryCalls).handle(tagged());

    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual(await first.json());
    expect(retryCalls).toEqual([]);
  });

  test("refuses a mention no channel member matches or several share, before posting anything", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const endpoint = directoryEndpoint(db, calls);

    const unknown = await endpoint.handle(
      postMilestone({ mentions: ["Juan Pérez", "Juan Gómez"] }),
    );
    const ambiguous = await endpoint.handle(
      postMilestone({ id: "evt-2", mentions: ["juan"] }),
    );

    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({
      error: "unknown_mention",
      mention: "Juan Gómez",
      ok: false,
    });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toEqual({
      candidates: [
        { name: "Juan Pérez", userId: "U0JUAN" },
        { name: "Juan Ruiz", userId: "U0JUANR" },
      ],
      error: "ambiguous_mention",
      mention: "juan",
      ok: false,
    });
    expect(calls).toEqual([]);
    expect(db.receipts.has("evt-1")).toBe(false);
    expect(db.receipts.has("evt-2")).toBe(false);
  });
});

const threadReader =
  (calls: RecordedCall[]): Fetcher =>
  (input, init) => {
    const url = v.parse(v.string(), input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = callBody(init);
    calls.push({ body, method });
    if (method === "conversations.replies") {
      return Promise.resolve(
        Response.json({
          has_more: false,
          messages: [
            {
              bot_id: "B1",
              text: "Release 42 · Started",
              ts: "171.1",
              user: "UBLOOP",
            },
            { bot_id: "B1", text: "Kicked off", ts: "171.2", user: "UBLOOP" },
            { text: "can you also bump the SDK?", ts: "171.3", user: "U0ANA" },
          ],
          ok: true,
        }),
      );
    }
    if (method === "conversations.info") {
      return Promise.resolve(
        Response.json({ channel: { name: "sandbox" }, ok: true }),
      );
    }
    if (method === "users.info") {
      const name = body.user === "U0ANA" ? "Ana" : "Bloop";
      return Promise.resolve(
        Response.json({ ok: true, user: { profile: { display_name: name } } }),
      );
    }
    if (method === "auth.test") {
      return Promise.resolve(
        Response.json({ ok: true, url: "https://workspace.slack.com/" }),
      );
    }
    return Promise.resolve(
      Response.json({ error: "unknown_method", ok: false }),
    );
  };

const getReplies = (
  query: Record<string, string>,
  authorization: string | null = `Bearer ${BEARER}`,
): Request =>
  new Request(
    `https://example.com/progress/replies?${new URLSearchParams(query).toString()}`,
    { headers: authorization === null ? {} : { authorization } },
  );

const threadReplies = [
  {
    author: "Bloop",
    permalink:
      "https://workspace.slack.com/archives/C1/p1712?thread_ts=171.1&cid=C1",
    text: "Kicked off",
    ts: "171.2",
  },
  {
    author: "Ana",
    permalink:
      "https://workspace.slack.com/archives/C1/p1713?thread_ts=171.1&cid=C1",
    text: "can you also bump the SDK?",
    ts: "171.3",
  },
];

const repliesEndpoint = (db: FakeD1, calls: RecordedCall[]) => {
  db.admissions.set("C1", ADMITTED_BY);
  db.roots.set(`C1\u0000release-42`, {
    owned: 1,
    root_text: "Release 42 · Started",
    root_ts: "171.1",
    status: null,
  });
  return endpointFor(db, calls, {
    fetcher: strictFetch(threadReader(calls)),
  });
};

const LONG_ROOT_TS = "171.000001";

const longThread = (replies: number) => [
  {
    bot_id: "B1",
    text: "Release 42 · Started",
    ts: LONG_ROOT_TS,
    user: "UBLOOP",
  },
  ...Array.from({ length: replies }, (_, index) => ({
    text: `reply ${String(index + 1)}`,
    ts: `171.${String(index + 2).padStart(6, "0")}`,
    user: "U0ANA",
  })),
];

const pagedThreadReader =
  (
    calls: RecordedCall[],
    messages: readonly { text: string; ts: string; user: string }[],
  ): Fetcher =>
  (input, init) => {
    const url = v.parse(v.string(), input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = callBody(init);
    calls.push({ body, method });
    if (method === "conversations.replies") {
      const oldest = Number(body.oldest ?? "0");
      const matching = messages.filter(
        (message, index) => index === 0 || Number(message.ts) > oldest,
      );
      const offset = Number(body.cursor ?? "0");
      const limit = Number(body.limit);
      const more = offset + limit < matching.length;
      return Promise.resolve(
        Response.json({
          has_more: more,
          messages: matching.slice(offset, offset + limit),
          ok: true,
          response_metadata: more
            ? { next_cursor: String(offset + limit) }
            : {},
        }),
      );
    }
    return threadReader([])(input, init);
  };

const longThreadEndpoint = (calls: RecordedCall[], replies: number) => {
  const db = new FakeD1();
  db.admissions.set("C1", ADMITTED_BY);
  db.roots.set(`C1\u0000release-42`, {
    owned: 1,
    root_text: "Release 42 · Started",
    root_ts: LONG_ROOT_TS,
    status: null,
  });
  return endpointFor(db, calls, {
    fetcher: strictFetch(pagedThreadReader(calls, longThread(replies))),
  });
};

describe("progress replies", () => {
  test("returns every reply of a thread that spans several pages", async () => {
    const calls: RecordedCall[] = [];
    const endpoint = longThreadEndpoint(calls, 450);

    const response = await endpoint.handleReplies(
      getReplies({ channel: "C1", task: "release-42" }),
    );

    const { messages } = v.parse(
      v.object({ messages: v.array(v.object({ ts: v.string() })) }),
      await response.json(),
    );
    expect(messages).toHaveLength(450);
    expect(messages.at(-1)?.ts).toBe("171.000451");
    expect(
      calls.filter((call) => call.method === "conversations.replies"),
    ).toHaveLength(3);
  });

  test("asks Slack only for what came after oldest, so a poll with nothing new reads nothing old", async () => {
    const calls: RecordedCall[] = [];
    const endpoint = longThreadEndpoint(calls, 450);

    const response = await endpoint.handleReplies(
      getReplies({ channel: "C1", oldest: "171.000451", task: "release-42" }),
    );

    expect(await response.json()).toEqual({ messages: [], ok: true });
    const replies = calls.filter(
      (call) => call.method === "conversations.replies",
    );
    expect(replies.map((call) => call.body.oldest)).toEqual(["171.000451"]);
    expect(calls.map((call) => call.method)).not.toContain("users.info");
  });

  test("returns every reply under a task's root, oldest first, named by author", async () => {
    const calls: RecordedCall[] = [];
    const endpoint = repliesEndpoint(new FakeD1(), calls);

    const response = await endpoint.handleReplies(
      getReplies({ channel: "C1", task: "release-42" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      messages: threadReplies,
      ok: true,
    });
    expect(
      calls.find((call) => call.method === "conversations.replies")?.body,
    ).toMatchObject({ channel: "C1", ts: "171.1" });
  });

  test("returns only the replies after oldest", async () => {
    const endpoint = repliesEndpoint(new FakeD1(), []);

    const response = await endpoint.handleReplies(
      getReplies({ channel: "C1", oldest: "171.2", task: "release-42" }),
    );

    expect(await response.json()).toEqual({
      messages: threadReplies.slice(1),
      ok: true,
    });
  });

  test("resolves the channel by name the way a milestone does", async () => {
    const endpoint = repliesEndpoint(new FakeD1(), []);

    const response = await endpoint.handleReplies(
      getReplies({ channel: "#Sandbox", task: "release-42" }),
    );

    expect(response.status).toBe(200);
  });

  test("refuses a task with no thread, a channel not admitted, and a malformed query without reading Slack", async () => {
    const calls: RecordedCall[] = [];
    const endpoint = repliesEndpoint(new FakeD1(), calls);

    const queries: Record<string, string>[] = [
      { channel: "C1", task: "release-43" },
      { channel: "C2", task: "release-42" },
      { task: "release-42" },
      { channel: "C1", oldest: "yesterday", task: "release-42" },
    ];
    const refusals = await Promise.all(
      queries.map(async (query) => {
        const response = await endpoint.handleReplies(getReplies(query));
        return { body: await response.json(), status: response.status };
      }),
    );

    expect(refusals).toEqual([
      { body: { error: "no_thread", ok: false }, status: 404 },
      { body: { error: "channel_not_admitted", ok: false }, status: 403 },
      { body: { error: "invalid_request", ok: false }, status: 400 },
      { body: { error: "invalid_request", ok: false }, status: 400 },
    ]);
    expect(calls.map((call) => call.method)).not.toContain(
      "conversations.replies",
    );
  });

  test("guards the replies with the same bearer", async () => {
    const calls: RecordedCall[] = [];
    const endpoint = repliesEndpoint(new FakeD1(), calls);

    const refusals = await Promise.all(
      authorizationRefusals.map(async (authorization) => {
        const response = await endpoint.handleReplies(
          getReplies({ channel: "C1", task: "release-42" }, authorization),
        );
        return response.status;
      }),
    );

    expect(refusals).toEqual([401, 401, 401]);
    expect(calls).toEqual([]);
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
    db.admissions.set("C1", ADMITTED_BY);
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

  test("serves the channel listing only when the endpoint is configured", async () => {
    const db = new FakeD1();
    db.admissions.set("C1", ADMITTED_BY);
    const calls: RecordedCall[] = [];
    const app = createApp(
      trusted,
      MODEL_PROVIDER_CLOUDFLARE,
      async () => {},
      undefined,
      undefined,
      undefined,
      endpointFor(db, calls, {
        fetcher: strictFetch(
          slackRecorder(calls, [], { C1: { name: "sandbox" } }),
        ),
      }),
    );

    const listed = await app.request(
      "/progress/channels",
      { headers: { authorization: `Bearer ${BEARER}` } },
      testBindings(db),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      channels: [{ id: "C1", kind: "channel", name: "sandbox" }],
      ok: true,
    });

    const refused = await app.request(
      "/progress/channels",
      undefined,
      testBindings(db),
    );
    expect(refused.status).toBe(401);

    const unconfigured = createApp(
      trusted,
      MODEL_PROVIDER_CLOUDFLARE,
      async () => {},
    );
    const absent = await unconfigured.request(
      "/progress/channels",
      undefined,
      testBindings(db),
    );
    expect(absent.status).toBe(404);
  });

  test("serves a task's replies only when the endpoint is configured", async () => {
    const db = new FakeD1();
    const calls: RecordedCall[] = [];
    const app = createApp(
      trusted,
      MODEL_PROVIDER_CLOUDFLARE,
      async () => {},
      undefined,
      undefined,
      undefined,
      repliesEndpoint(db, calls),
    );

    const listed = await app.request(
      "/progress/replies?channel=C1&task=release-42",
      { headers: { authorization: `Bearer ${BEARER}` } },
      testBindings(db),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ messages: threadReplies, ok: true });

    const unconfigured = createApp(
      trusted,
      MODEL_PROVIDER_CLOUDFLARE,
      async () => {},
    );
    const absent = await unconfigured.request(
      "/progress/replies?channel=C1&task=release-42",
      { headers: { authorization: `Bearer ${BEARER}` } },
      testBindings(db),
    );
    expect(absent.status).toBe(404);
  });
});
