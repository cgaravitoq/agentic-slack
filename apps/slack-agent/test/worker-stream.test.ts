import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { slackDeliveryBindingSchema } from "@agentic-slack/core";
import {
  evictLiveSlackDelivery,
  SLACK_DELIVERY_FALLBACK,
} from "../../../packages/core/src/delivery.ts";
import type { ConversationLifecycleAgent } from "../../../packages/core/src/retention.ts";
import type {
  Agent,
  ConversationStreamChunk,
  DispatchReceipt,
  FlueObservation,
} from "@flue/runtime";
import * as v from "valibot";
import { mockCloudflareWorkers, mockWorkersAi } from "./module-mocks.ts";

const BOT_TOKEN = "xoxb-worker-token";
const SIGNING_SECRET = "signing-secret-for-tests-1234567890";
const STREAM_TS = "171.9";
const repeatingAlphabet = (length: number): string =>
  Array.from({ length }, (_, index) =>
    String.fromCodePoint(97 + (index % 26)),
  ).join("");

interface SlackCall {
  authorization: string;
  method: string;
  body: Record<string, string | unknown[]>;
}

interface HandleDispatchRequest {
  idempotencyKey?: string;
  initialData?: unknown;
  message: {
    attributes?: Record<string, string>;
    body: string;
    kind: string;
    type: string;
  };
}

const slackCalls: SlackCall[] = [];
const dispatched: { instanceId: string; request: HandleDispatchRequest }[] = [];
let reactionError: string | undefined;
let reactionHang = false;
let reactionStatus = 200;
let deltas: string[] = [];
let toolChunks: ConversationStreamChunk[] = [];
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

const toolInput = (
  toolCallId: string,
  toolName: string,
): ConversationStreamChunk => ({
  conversationId: "c1",
  input: { query: "anything" },
  messageId: "m1",
  position,
  toolCallId,
  toolName,
  type: "tool-input",
});

const toolOutput = (
  toolCallId: string,
  output:
    | string
    | {
        api_key: string;
        auth: string;
        note: string;
        password: string;
      }
    | { body: string; status: number }
    | { stderr: string }
    | null,
): ConversationStreamChunk => ({
  conversationId: "c1",
  output,
  position,
  toolCallId,
  type: "tool-output",
});

const toolOutputError = (
  toolCallId: string,
  errorText: string,
): ConversationStreamChunk => ({
  conversationId: "c1",
  errorText,
  position,
  toolCallId,
  type: "tool-output-error",
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
      for (const chunk of toolChunks) {
        readOptions?.onEvent?.(chunk);
      }
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
const sqlRows = new Map<string, string>();
let createTableCount = 0;
let saveCount = 0;
const fakeSql = {
  exec(query: string, ...bindings: unknown[]) {
    if (query.includes("CREATE TABLE")) {
      createTableCount += 1;
      return { toArray: () => [] };
    }
    if (query.trimStart().startsWith("SELECT")) {
      const payload = sqlRows.get(String(bindings[0]));
      return {
        toArray: () => (payload === undefined ? [] : [{ payload }]),
      };
    }
    saveCount += 1;
    sqlRows.set(String(bindings[0]), String(bindings[1]));
    return { toArray: () => [] };
  },
};
const cloudflare = await import("@flue/runtime/cloudflare");
await mock.module("@flue/runtime/cloudflare", () => ({
  ...cloudflare,
  createCloudflareTracing: () => ({}),
  extend: () => ({ base: undefined }),
  getCloudflareContext: () => ({
    env: {},
    storage: { sql: fakeSql },
  }),
}));
await mockWorkersAi();

const originalFetch = globalThis.fetch;
const createLifoSettler = <T>() => {
  let batch: { resolve: (next: T) => void; value: T }[] = [];
  let scheduled = false;
  return (value: T): Promise<T> => {
    const deferred = Promise.withResolvers<T>();
    batch.push({ resolve: deferred.resolve, value });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        const pending = batch;
        batch = [];
        scheduled = false;
        for (const waiter of pending.toReversed()) {
          waiter.resolve(waiter.value);
        }
      });
    }
    return deferred.promise;
  };
};
const settleFetch = createLifoSettler<Response>();
const capturingFetch: Pick<typeof globalThis, "fetch">["fetch"] = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    if (!v.is(v.string(), input) || !v.is(v.string(), init?.body)) {
      throw new TypeError("Expected a Slack URL string and a JSON body");
    }
    const recorded = {
      authorization: v.parse(
        v.object({ authorization: v.string() }),
        init.headers,
      ).authorization,
      body: v.parse(
        v.record(v.string(), v.union([v.string(), v.array(v.unknown())])),
        JSON.parse(init.body),
      ),
      method: input.replace("https://slack.com/api/", ""),
    };
    const isReaction = recorded.method === "reactions.add";
    if (isReaction && reactionHang) {
      slackCalls.push(recorded);
      return Promise.withResolvers<Response>().promise;
    }
    const rejected = isReaction && reactionError !== undefined;
    return settleFetch(
      Response.json(
        rejected
          ? { error: reactionError, ok: false }
          : { ok: true, ts: STREAM_TS },
        { status: isReaction ? reactionStatus : 200 },
      ),
    ).then((response) => {
      slackCalls.push(recorded);
      return response;
    });
  },
  { preconnect: originalFetch.preconnect },
);
globalThis.fetch = capturingFetch;

const workerModule = await import("../src/index.ts");
const app = workerModule.default;
const {
  finishSlackTurnDelivery,
  observeSlackTurnDelivery,
  startSlackTurnDelivery,
} = await import("../src/agent.ts");

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
  threadTs = "171.0",
): Promise<Request> => {
  const body = JSON.stringify({
    api_app_id: "A123",
    event: {
      channel: "C777",
      text,
      thread_ts: threadTs,
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

const signedDirectMessage = async (
  eventId: string,
  ts: string,
  text = "hello",
): Promise<Request> => {
  const body = JSON.stringify({
    api_app_id: "A123",
    event: {
      channel: "D777",
      channel_type: "im",
      text,
      ts,
      type: "message",
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

const admitTurn = async (
  request: Request,
): Promise<{ pending: Promise<unknown>[]; status: number }> => {
  const pending: Promise<unknown>[] = [];
  const response = await app.request(request, undefined, testBindings(), {
    passThroughOnException() {},
    props: {},
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  });
  return { pending, status: response.status };
};

const observationEnvelope = (
  instanceId: string,
): Pick<FlueObservation, "eventIndex" | "instanceId" | "timestamp" | "v"> => ({
  eventIndex: 0,
  instanceId,
  timestamp: "2026-01-01T00:00:00.000Z",
  v: 3,
});

const observationFromChunk = (
  chunk: ConversationStreamChunk,
  instanceId: string,
): FlueObservation | undefined => {
  const envelope = observationEnvelope(instanceId);
  if (chunk.type === "message-delta" && chunk.kind === "text") {
    return { ...envelope, text: chunk.delta, type: "text_delta" };
  }
  if (chunk.type === "tool-input") {
    return {
      ...envelope,
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      type: "tool_start",
    };
  }
  if (chunk.type === "tool-output") {
    return {
      ...envelope,
      durationMs: 0,
      effectiveResult: chunk.output,
      isError: false,
      result: chunk.output,
      toolCallId: chunk.toolCallId,
      toolName: "",
      type: "tool",
    };
  }
  if (chunk.type === "tool-output-error") {
    return {
      ...envelope,
      durationMs: 0,
      errorInfo: { message: chunk.errorText, type: "tool" },
      isError: true,
      result: {},
      toolCallId: chunk.toolCallId,
      toolName: "",
      type: "tool",
    };
  }
  return undefined;
};

const deliverFromAlarm = async (evictLive = false): Promise<void> => {
  const last = dispatched.at(-1);
  const instanceId = last?.instanceId ?? "";
  const binding = v.parse(
    slackDeliveryBindingSchema,
    last?.request.initialData,
  );
  startSlackTurnDelivery(instanceId, binding);
  if (evictLive) {
    evictLiveSlackDelivery(instanceId);
  }
  const chunks = [
    ...toolChunks,
    ...deltas.flatMap((text) => [
      delta(text, "text" as const),
      delta("SECRET_THOUGHT=leak", "reasoning" as const),
    ]),
  ];
  for (const chunk of chunks) {
    const observation = observationFromChunk(chunk, instanceId);
    if (observation !== undefined) {
      void observeSlackTurnDelivery(observation);
    }
  }
  if (runFailure !== undefined) {
    await observeSlackTurnDelivery({
      ...observationEnvelope(instanceId),
      outcome: "failed",
      submissionId: "sub-1",
      type: "submission_settled",
    });
    return;
  }
  await finishSlackTurnDelivery(instanceId);
};

const runTurn = async (eventId: string, text?: string): Promise<number> => {
  const { pending, status } = await admitTurn(
    await signedMention(eventId, text),
  );
  await Promise.all(pending);
  await deliverFromAlarm();
  return status;
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
    .map((body) =>
      v.is(v.string(), body.markdown_text) ? body.markdown_text : "",
    )
    .join("");

const taskChunks = () =>
  bodiesFor("chat.appendStream").flatMap((body) =>
    v.is(v.array(v.unknown()), body.chunks) ? body.chunks : [],
  );

beforeEach(() => {
  slackCalls.length = 0;
  dispatched.length = 0;
  reactionError = undefined;
  reactionHang = false;
  reactionStatus = 200;
  deltas = [];
  toolChunks = [];
  replyText = "";
  runFailure = undefined;
  sqlRows.clear();
  evictLiveSlackDelivery();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("builds the durable delivery store once and flushes it on the coalesce boundary", async () => {
  deltas = ["warm"];
  replyText = "warm";
  expect(await runTurn("Ev-store-warm")).toBe(200);
  expect(createTableCount).toBe(1);

  deltas = Array.from({ length: 300 }, () => repeatingAlphabet(4));
  replyText = deltas.join("");
  const saves = saveCount;
  slackCalls.length = 0;
  expect(await runTurn("Ev-store-batch")).toBe(200);

  expect(createTableCount).toBe(1);
  // Bounded from below too: a policy that stops flushing saves only the open
  // and the close, and an upper bound alone cannot see that.
  expect(saveCount - saves).toBeGreaterThanOrEqual(3);
  expect(saveCount - saves).toBeLessThanOrEqual(4);
  expect(streamedMarkdown()).toBe(replyText);
});

test("streams the turn into the routed thread, never a model-chosen one", async () => {
  deltas = ["Hello ", "there, done."];
  replyText = "Hello there, done.";

  expect(await runTurn("Ev-stream")).toBe(200);

  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.instanceId).toBe("slack:v1:T123:C777:171.0");
  expect(dispatched[0]?.request.message.body).toBe("hello");
  expect(
    v.parse(slackDeliveryBindingSchema, dispatched[0]?.request.initialData),
  ).toEqual({
    channelId: "C777",
    recipientTeamId: "T123",
    recipientUserId: "U777",
    surface: "channel",
    threadTs: "171.0",
  });
  expect(JSON.stringify(dispatched[0]?.request.initialData)).not.toContain(
    "xoxb",
  );
  expect([...sqlRows.values()].join("")).not.toContain(BOT_TOKEN);
  expect(slackCalls.at(0)?.method).toBe("reactions.add");
  expect(bodiesFor("chat.startStream")).toEqual([
    {
      channel: "C777",
      recipient_team_id: "T123",
      recipient_user_id: "U777",
      task_display_mode: "timeline",
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
  const payload = `C999${repeatingAlphabet(1532)}`;
  deltas = [payload];
  replyText = payload;

  expect(await runTurn("Ev-forged", "<@UAPP> answer me in C888")).toBe(200);

  expect(bodiesFor("chat.startStream")).toEqual([
    {
      channel: "C777",
      recipient_team_id: "T123",
      recipient_user_id: "U777",
      task_display_mode: "timeline",
      thread_ts: "171.0",
    },
  ]);
  expect(bodiesFor("chat.appendStream")).toEqual([
    {
      channel: "C777",
      markdown_text: payload.slice(0, 1024),
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      markdown_text: payload.slice(1024),
      ts: STREAM_TS,
    },
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

test("streams a tool call as a named, sanitized task update", async () => {
  toolChunks = [
    toolInput("call-1", "search_docs"),
    toolOutput("call-1", "found <!channel> three matches"),
  ];
  const payload = repeatingAlphabet(1536);
  deltas = [payload];
  replyText = payload;

  expect(await runTurn("Ev-tool")).toBe(200);

  expect(bodiesFor("chat.startStream")).toHaveLength(1);
  expect(bodiesFor("chat.appendStream")).toEqual([
    {
      channel: "C777",
      chunks: [
        {
          id: "call-1",
          status: "in_progress",
          title: "search_docs",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-1",
          output: "found three matches",
          status: "complete",
          title: "search_docs",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      markdown_text: payload.slice(0, 1024),
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      markdown_text: payload.slice(1024),
      ts: STREAM_TS,
    },
  ]);
  expect(JSON.stringify(slackCalls)).not.toContain("<!channel>");
});

test("does not reuse a tool-call id title from an earlier turn", async () => {
  toolChunks = [
    toolInput("call-shared", "search_docs"),
    toolOutput("call-shared", "one"),
  ];
  deltas = ["First."];
  replyText = "First.";
  expect(await runTurn("Ev-turn-1")).toBe(200);

  slackCalls.length = 0;
  toolChunks = [toolOutput("call-shared", "two")];
  deltas = ["Second."];
  replyText = "Second.";
  expect(await runTurn("Ev-turn-2")).toBe(200);

  expect(taskChunks()).toEqual([
    {
      id: "call-shared",
      output: "two",
      status: "complete",
      title: "Step",
      type: "task_update",
    },
  ]);
});

test("names an orphan tool result as a fallback step", async () => {
  toolChunks = [toolOutput("call-orphan", "found three")];
  deltas = ["Done."];
  replyText = "Done.";

  expect(await runTurn("Ev-orphan")).toBe(200);

  expect(taskChunks()).toEqual([
    {
      id: "call-orphan",
      output: "found three",
      status: "complete",
      title: "Step",
      type: "task_update",
    },
  ]);
});

test("omits the output of a void tool result", async () => {
  toolChunks = [toolInput("call-void", "noop"), toolOutput("call-void", null)];
  deltas = ["Done."];
  replyText = "Done.";

  expect(await runTurn("Ev-void")).toBe(200);

  expect(bodiesFor("chat.appendStream")).toEqual([
    {
      channel: "C777",
      chunks: [
        {
          id: "call-void",
          status: "in_progress",
          title: "noop",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-void",
          status: "complete",
          title: "noop",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    { channel: "C777", markdown_text: "Done.", ts: STREAM_TS },
  ]);
});

test("marks a failed tool as an error and still finishes the reply", async () => {
  toolChunks = [
    toolInput("call-2", "search_docs"),
    toolOutputError("call-2", "upstream refused the request"),
  ];
  deltas = ["I could not look that up."];
  replyText = "I could not look that up.";

  expect(await runTurn("Ev-tool-error")).toBe(200);

  expect(taskChunks()).toEqual([
    {
      id: "call-2",
      status: "in_progress",
      title: "search_docs",
      type: "task_update",
    },
    {
      id: "call-2",
      output: "upstream refused the request",
      status: "error",
      title: "search_docs",
      type: "task_update",
    },
  ]);
  expect(streamedMarkdown()).toBe("I could not look that up.");
  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
});

test("redacts credentials carried in a tool result before the wire", async () => {
  toolChunks = [
    toolInput("call-3", "read_env"),
    toolOutput("call-3", {
      api_key: "AKIA-live-1",
      auth: "xoxb-1234567890-abcdef",
      note: "SLACK_SIGNING_SECRET=hunter2",
      password: "hunter2,admin",
    }),
  ];
  deltas = ["Done."];
  replyText = "Done.";

  expect(await runTurn("Ev-tool-secret")).toBe(200);

  expect(bodiesFor("chat.appendStream")).toEqual([
    {
      channel: "C777",
      chunks: [
        {
          id: "call-3",
          status: "in_progress",
          title: "read_env",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-3",
          output:
            '{[internal configuration],"auth":"[secret]","note":[internal configuration]",[internal configuration]}',
          status: "complete",
          title: "read_env",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    { channel: "C777", markdown_text: "Done.", ts: STREAM_TS },
  ]);
});

test("redacts credentials escaped by JSON.stringify before the wire", async () => {
  toolChunks = [
    toolInput("call-http", "http_get"),
    toolOutput("call-http", {
      body: '{"password":"hunter2","api_key":"AKIA-live-1"}',
      status: 200,
    }),
    toolInput("call-err", "run_cmd"),
    toolOutput("call-err", {
      stderr: 'auth failed for PASSWORD="hunter2"',
    }),
  ];
  deltas = ["Done."];
  replyText = "Done.";

  expect(await runTurn("Ev-escaped-secret")).toBe(200);

  expect(bodiesFor("chat.appendStream")).toEqual([
    {
      channel: "C777",
      chunks: [
        {
          id: "call-http",
          status: "in_progress",
          title: "http_get",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-http",
          output:
            '{"body":"{[internal configuration],[internal configuration]}","status":200}',
          status: "complete",
          title: "http_get",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-err",
          status: "in_progress",
          title: "run_cmd",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-err",
          output: '{"stderr":"auth failed for [internal configuration]"}',
          status: "complete",
          title: "run_cmd",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    { channel: "C777", markdown_text: "Done.", ts: STREAM_TS },
  ]);
});

test("returns 200 without awaiting delivery, and the DO alarm path streams the reply", async () => {
  deltas = ["Hello ", "there, done."];
  replyText = "Hello there, done.";

  const { pending, status } = await admitTurn(await signedMention("Ev-ack"));
  expect(status).toBe(200);
  await Promise.all(pending);

  expect(bodiesFor("chat.startStream")).toEqual([]);
  expect(bodiesFor("chat.appendStream")).toEqual([]);
  expect(bodiesFor("chat.stopStream")).toEqual([]);

  await deliverFromAlarm();

  expect(bodiesFor("chat.startStream")).toEqual([
    {
      channel: "C777",
      recipient_team_id: "T123",
      recipient_user_id: "U777",
      task_display_mode: "timeline",
      thread_ts: "171.0",
    },
  ]);
  expect(streamedMarkdown()).toBe("Hello there, done.");
  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
});

test("delivers the durable reply after the isolate drops its live stream handle", async () => {
  toolChunks = [
    toolInput("call-1", "search_docs"),
    toolOutput("call-1", "found three matches"),
  ];
  deltas = ["Hello ", "there, done."];
  replyText = "Hello there, done.";

  const { pending, status } = await admitTurn(await signedMention("Ev-evict"));
  expect(status).toBe(200);
  await Promise.all(pending);
  await deliverFromAlarm(true);

  expect(bodiesFor("chat.appendStream")).toEqual([
    {
      channel: "C777",
      chunks: [
        {
          id: "call-1",
          status: "in_progress",
          title: "search_docs",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    {
      channel: "C777",
      chunks: [
        {
          id: "call-1",
          output: "found three matches",
          status: "complete",
          title: "search_docs",
          type: "task_update",
        },
      ],
      ts: STREAM_TS,
    },
    { channel: "C777", markdown_text: "Hello there, done.", ts: STREAM_TS },
  ]);
  expect(streamedMarkdown()).toBe("Hello there, done.");
  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
});

test("a retried finish does not post a second Slack stream", async () => {
  deltas = ["Hello."];
  replyText = "Hello.";

  expect(await runTurn("Ev-once")).toBe(200);
  const calls = slackCalls.length;
  await finishSlackTurnDelivery(dispatched.at(-1)?.instanceId ?? "");

  expect(slackCalls).toHaveLength(calls);
  expect(bodiesFor("chat.startStream")).toHaveLength(1);
});

test("finishes with the reply text accumulated in durable state", async () => {
  deltas = ["The complete answer."];
  replyText = "The complete answer.";

  const { pending, status } = await admitTurn(
    await signedMention("Ev-reply-text"),
  );
  expect(status).toBe(200);
  await Promise.all(pending);
  await deliverFromAlarm(true);

  expect(streamedMarkdown()).toBe("The complete answer.");
  expect(streamedMarkdown()).not.toBe(SLACK_DELIVERY_FALLBACK);
  expect(bodiesFor("chat.stopStream")).toEqual([
    { channel: "C777", ts: STREAM_TS },
  ]);
});

test("routes successive top-level DMs to one instance and keeps channel threads apart", async () => {
  const first = await admitTurn(
    await signedDirectMessage("Ev-dm-1", "181.1", "first"),
  );
  await Promise.all(first.pending);
  const second = await admitTurn(
    await signedDirectMessage("Ev-dm-2", "182.2", "second"),
  );
  await Promise.all(second.pending);
  const mentionA = await admitTurn(
    await signedMention("Ev-mention-a", "<@UAPP> one", "191.0"),
  );
  await Promise.all(mentionA.pending);
  const mentionB = await admitTurn(
    await signedMention("Ev-mention-b", "<@UAPP> two", "192.0"),
  );
  await Promise.all(mentionB.pending);

  expect(dispatched.map((entry) => entry.instanceId)).toEqual([
    "slack:v1:T123:D777:D777",
    "slack:v1:T123:D777:D777",
    "slack:v1:T123:C777:191.0",
    "slack:v1:T123:C777:192.0",
  ]);
});

test("a failed eyes reaction still dispatches the turn", async () => {
  const fixtures: { error: string; status: number }[] = [
    { error: "already_reacted", status: 200 },
    { error: "not_in_channel", status: 200 },
    { error: "missing_scope", status: 200 },
    { error: "rate_limited", status: 429 },
  ];
  for (const fixture of fixtures) {
    slackCalls.length = 0;
    dispatched.length = 0;
    reactionError = fixture.error;
    reactionStatus = fixture.status;
    deltas = ["Hello."];
    replyText = "Hello.";

    // oxlint-disable-next-line no-await-in-loop
    expect(await runTurn(`Ev-react-${fixture.error}`)).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(streamedMarkdown()).toBe("Hello.");
    expect(slackCalls[0]?.method).toBe("reactions.add");
  }
});

test("a hanging eyes reaction still dispatches the turn", async () => {
  reactionHang = true;
  deltas = ["Hello."];
  replyText = "Hello.";

  expect(await runTurn("Ev-react-hang")).toBe(200);
  expect(dispatched).toHaveLength(1);
  expect(streamedMarkdown()).toBe("Hello.");
  expect(slackCalls[0]?.method).toBe("reactions.add");
}, 500);
