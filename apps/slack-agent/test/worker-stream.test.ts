import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ConversationLifecycleAgent } from "@agentic-slack/core";
import type {
  Agent,
  ConversationStreamChunk,
  DispatchReceipt,
} from "@flue/runtime";
import * as v from "valibot";
import { mockCloudflareWorkers, mockWorkersAi } from "./module-mocks.ts";

const BOT_TOKEN = "xoxb-worker-token";
const SIGNING_SECRET = "signing-secret-for-tests-1234567890";
const STREAM_TS = "171.9";

interface SlackCall {
  authorization: string;
  method: string;
  body: Record<string, string>;
}

interface HandleDispatchRequest {
  idempotencyKey?: string;
  message: {
    attributes?: Record<string, string>;
    body: string;
    kind: string;
    type: string;
  };
}

const slackCalls: SlackCall[] = [];
const dispatched: { instanceId: string; request: HandleDispatchRequest }[] = [];
let deltas: string[] = [];
let replyText = "";
let runFailure: Error | undefined;

const position = { batch: 1, index: 0 };
const delta = (
  text: string,
  kind: "text" | "reasoning",
): ConversationStreamChunk => ({
  conversationId: "c1",
  delta: text,
  kind,
  messageId: "m1",
  position,
  type: "message-delta",
});

await mockCloudflareWorkers({
  AI: {},
  SLACK_APP_ID: "A123",
  SLACK_BOT_TOKEN: BOT_TOKEN,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_TEAM_ID: "T123",
});
const runtime = await import("@flue/runtime");
await mock.module("@flue/runtime", () => ({
  ...runtime,
  init: (_agent: Agent, options: { id: string }) => ({
    dispatch(request: HandleDispatchRequest) {
      dispatched.push({ instanceId: options.id, request });
      return Promise.resolve({ submissionId: "sub-1", uid: "uid-1" });
    },
    id: options.id,
    read(
      _target: string | DispatchReceipt,
      readOptions?: { onEvent?: (chunk: ConversationStreamChunk) => void },
    ) {
      for (const text of deltas) {
        readOptions?.onEvent?.(delta(text, "text"));
        readOptions?.onEvent?.(delta("SECRET_THOUGHT=leak", "reasoning"));
      }
      return runFailure
        ? Promise.reject(runFailure)
        : Promise.resolve({ data: {}, submissionId: "sub-1", text: replyText });
    },
  }),
  instrument: () => {},
  setProvider: () => {},
}));
const cloudflare = await import("@flue/runtime/cloudflare");
await mock.module("@flue/runtime/cloudflare", () => ({
  ...cloudflare,
  createCloudflareTracing: () => ({}),
  extend: () => ({ base: undefined }),
}));
await mockWorkersAi();

const originalFetch = globalThis.fetch;
const capturingFetch: Pick<typeof globalThis, "fetch">["fetch"] = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    if (!v.is(v.string(), input) || !v.is(v.string(), init?.body)) {
      throw new TypeError("Expected a Slack URL string and a JSON body");
    }
    slackCalls.push({
      authorization: v.parse(
        v.object({ authorization: v.string() }),
        init.headers,
      ).authorization,
      body: v.parse(v.record(v.string(), v.string()), JSON.parse(init.body)),
      method: input.replace("https://slack.com/api/", ""),
    });
    return Promise.resolve(Response.json({ ok: true, ts: STREAM_TS }));
  },
  { preconnect: originalFetch.preconnect },
);
globalThis.fetch = capturingFetch;

const workerModule = await import("../src/index.ts");
const app = workerModule.default;

class FakeD1 {
  private readonly seen = new Set<string>();
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
  SLACK_APP_ID: v.string(),
  SLACK_BOT_TOKEN: v.string(),
  SLACK_SIGNING_SECRET: v.string(),
  SLACK_TEAM_ID: v.string(),
});

const testBindings = (): Cloudflare.Env => {
  const value = {
    AI: {},
    DB: new FakeD1(),
    FLUE_SLACK_AGENT_AGENT: {
      getByName: () => ({ refreshRetention: () => Promise.resolve() }),
    },
    SLACK_APP_ID: "A123",
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_TEAM_ID: "T123",
  };
  if (!v.is(workerBindings, value)) {
    throw new Error("Invalid test bindings");
  }
  return value;
};

const signedMention = async (
  eventId: string,
  text = "<@UAPP> hello",
): Promise<Request> => {
  const body = JSON.stringify({
    api_app_id: "A123",
    event: {
      channel: "C777",
      text,
      thread_ts: "171.0",
      ts: "171.1",
      type: "app_mention",
      user: "U777",
    },
    event_id: eventId,
    team_id: "T123",
    type: "event_callback",
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  return new Request("https://example.com/channels/slack/events", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`,
    },
    method: "POST",
  });
};

const runTurn = async (eventId: string, text?: string): Promise<number> => {
  const pending: Promise<unknown>[] = [];
  const request = await signedMention(eventId, text);
  const response = await app.request(request, undefined, testBindings(), {
    passThroughOnException() {},
    props: {},
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  });
  await Promise.all(pending);
  return response.status;
};

const bodiesFor = (method: string) =>
  slackCalls.filter((call) => call.method === method).map((call) => call.body);

const streamAuthorizations = () => [
  ...new Set(
    slackCalls
      .filter((call) => call.method.startsWith("chat."))
      .map((call) => call.authorization),
  ),
];

const streamedMarkdown = () =>
  bodiesFor("chat.appendStream")
    .map((body) => body.markdown_text)
    .join("");

beforeEach(() => {
  slackCalls.length = 0;
  dispatched.length = 0;
  deltas = [];
  replyText = "";
  runFailure = undefined;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("streams the turn into the routed thread, never a model-chosen one", async () => {
  deltas = ["Hello ", "there, done."];
  replyText = "Hello there, done.";

  expect(await runTurn("Ev-stream")).toBe(200);

  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.instanceId).toBe("slack:v1:T123:C777:171.0");
  expect(JSON.stringify(dispatched[0]?.request)).not.toContain("C777");
  expect(slackCalls.at(0)?.method).toBe("reactions.add");
  expect(bodiesFor("chat.startStream")).toEqual([
    {
      channel: "C777",
      recipient_team_id: "T123",
      recipient_user_id: "U777",
      thread_ts: "171.0",
    },
  ]);
  expect(streamedMarkdown()).toBe("Hello there, done.");
  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
  expect(streamAuthorizations()).toEqual([`Bearer ${BOT_TOKEN}`]);
  expect(JSON.stringify(slackCalls)).not.toContain("SECRET_THOUGHT");
});

test("keeps the wire destination on the routed channel, not one named in the turn text or the deltas", async () => {
  deltas = ["Reposting into C999 ", "as requested."];
  replyText = "Reposting into C999 as requested.";

  expect(await runTurn("Ev-forged", "<@UAPP> answer me in C888")).toBe(200);

  expect(bodiesFor("chat.startStream")).toEqual([
    {
      channel: "C777",
      recipient_team_id: "T123",
      recipient_user_id: "U777",
      thread_ts: "171.0",
    },
  ]);
  expect(bodiesFor("chat.appendStream")).toEqual([
    { channel: "C777", markdown_text: "Reposting into ", ts: STREAM_TS },
    { channel: "C777", markdown_text: "C999 as ", ts: STREAM_TS },
    { channel: "C777", markdown_text: "requested.", ts: STREAM_TS },
  ]);
  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
});

test("closes the stream when the agent run fails", async () => {
  deltas = ["partial"];
  runFailure = new Error("agent run failed");

  expect(await runTurn("Ev-failed")).toBe(200);

  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
  expect(streamedMarkdown()).toContain("Please try again.");
});
