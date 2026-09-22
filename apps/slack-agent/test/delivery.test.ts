import { describe, expect, test } from "bun:test";
import {
  applySlackDeliveryEvent,
  failSlackDelivery,
  finishSlackDelivery,
  openSlackDelivery,
  slackEventFromObservation,
} from "@agentic-slack/core";
import type { RoutedSlackTurn, SlackDeliveryStore } from "@agentic-slack/core";
import type { FlueObservation } from "@flue/runtime";
// `createSlackStream` takes a nominal target, so it and the two helpers that
// build one come from the same module rather than from the package entry.
import {
  COALESCE_CHARS,
  COALESCE_MS,
  createSlackStream,
  createStreamSanitizer,
  evictLiveSlackDelivery,
  MAX_RETRY_AFTER_MS,
  MAX_RETRY_WAIT_MS,
  MAX_SLACK_APPEND_LENGTH,
  MAX_SLACK_MESSAGE_LENGTH,
  retryWait,
  sanitizeReply,
  SLACK_DELIVERY_FALLBACK,
  slackDeliveryBinding,
  SLACK_STREAM_FAILURE_NOTICE,
  STREAM_TAIL_LENGTH,
  streamTargetFor,
} from "../../../packages/core/src/delivery.ts";
import type { SlackDeliveryEvent } from "../../../packages/core/src/delivery.ts";
import {
  MAX_SLACK_TASK_CHUNK_LENGTH,
  SLACK_TASK_FALLBACK_TITLE,
} from "../../../packages/core/src/task-chunk.ts";
import * as v from "valibot";

const BOT_TOKEN = "xoxb-trusted-token";
const encodedLength = (text: string): number =>
  new TextEncoder().encode(text).length;
const STREAM_TS = "171.9";

// Strict objects: an extra key, a wrapper envelope or a renamed field fails the
// parse, so the fake only accepts Slack's exact streaming wire shape.
const startStreamBody = v.strictObject({
  channel: v.string(),
  task_display_mode: v.picklist(["timeline", "plan", "dense"]),
  thread_ts: v.string(),
});
const channelStartStreamBody = v.strictObject({
  channel: v.string(),
  recipient_team_id: v.string(),
  recipient_user_id: v.string(),
  task_display_mode: v.picklist(["timeline", "plan", "dense"]),
  thread_ts: v.string(),
});
// Slack's `task_update` chunk shape, rejecting the `task_card` block shape:
// `task_id` or a rich_text `output` fails the parse rather than being echoed.
const taskChunk = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  output: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_SLACK_TASK_CHUNK_LENGTH),
    ),
  ),
  status: v.picklist(["pending", "in_progress", "complete", "error"]),
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_SLACK_TASK_CHUNK_LENGTH),
  ),
  type: v.literal("task_update"),
});
const markdownAppendBody = v.strictObject({
  channel: v.string(),
  markdown_text: v.pipe(v.string(), v.minLength(1), v.maxLength(12_000)),
  ts: v.string(),
});
const taskAppendBody = v.strictObject({
  channel: v.string(),
  chunks: v.pipe(v.array(taskChunk), v.minLength(1)),
  ts: v.string(),
});
const appendStreamBody = v.union([markdownAppendBody, taskAppendBody]);
const stopStreamBody = v.strictObject({ channel: v.string(), ts: v.string() });

interface SlackCall {
  method: string;
  body: unknown;
}

interface FakeSlack {
  calls: SlackCall[];
  accepted: SlackCall[];
  methods: () => string[];
  acceptedMethods: () => string[];
  markdown: () => string;
  markdownChunks: () => string[];
  acceptedChunks: () => string[];
  taskChunks: () => unknown[];
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

// `skip` occurrences of a method are answered ok before the next `limit` are
// rejected, so a transient mid-stream failure can be staged. With `windowMs`
// the method instead stays rejected until that much simulated time has passed,
// announcing the seconds left exactly as Slack does.
interface FakeSlackFailures {
  limit?: number;
  now?: () => number;
  skip?: number;
  status?: number;
  retryAfter?: string;
  windowMs?: number;
}

// Concurrent fetches in one turn complete last-in first-out, so a uniform
// queue bypass cannot hide behind the microtask order of Promise.resolve.
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

const createFakeSlack = (
  failures: Partial<Record<string, string>> = {},
  {
    limit = Number.POSITIVE_INFINITY,
    now,
    skip = 0,
    status = 200,
    retryAfter,
    windowMs,
  }: FakeSlackFailures = {},
): FakeSlack => {
  const calls: SlackCall[] = [];
  const accepted: SlackCall[] = [];
  const seen = new Map<string, number>();
  const settle = createLifoSettler<Response>();
  const clock = (): number => now?.() ?? performance.now();
  const windowEnd = windowMs === undefined ? undefined : clock() + windowMs;
  const chunksOf = (recorded: SlackCall[]) =>
    recorded
      .filter((call) => call.method === "chat.appendStream")
      .map((call) => v.parse(appendStreamBody, call.body))
      .filter((body) => v.is(markdownAppendBody, body))
      .map((body) => body.markdown_text);
  const markdownChunks = () => chunksOf(calls);
  return {
    accepted,
    acceptedChunks: () => chunksOf(accepted),
    acceptedMethods: () => accepted.map((call) => call.method),
    calls,
    fetcher(input, init) {
      if (!v.is(v.string(), input)) {
        throw new TypeError("Expected a Slack URL string");
      }
      const method = input.replace("https://slack.com/api/", "");
      if (
        init?.method !== "POST" ||
        !v.is(
          v.object({
            authorization: v.literal(`Bearer ${BOT_TOKEN}`),
            "content-type": v.literal("application/json; charset=utf-8"),
          }),
          init.headers,
        )
      ) {
        throw new Error(`Unexpected ${method} request envelope`);
      }
      if (!v.is(v.string(), init.body)) {
        throw new TypeError(`Expected a JSON body for ${method}`);
      }
      const raw: unknown = JSON.parse(init.body);
      let call: SlackCall;
      if (method === "chat.startStream") {
        const surfaced = v.is(v.object({ recipient_user_id: v.string() }), raw)
          ? channelStartStreamBody
          : startStreamBody;
        call = { body: v.parse(surfaced, raw), method };
      } else if (method === "chat.appendStream") {
        call = { body: v.parse(appendStreamBody, raw), method };
      } else if (method === "chat.stopStream") {
        call = { body: v.parse(stopStreamBody, raw), method };
      } else {
        throw new Error(`Unexpected Slack method ${method}`);
      }
      const error = failures[method];
      const occurrence = (seen.get(method) ?? 0) + 1;
      seen.set(method, occurrence);
      const remaining =
        windowEnd === undefined ? undefined : windowEnd - clock();
      const rejected =
        error !== undefined &&
        (remaining === undefined
          ? occurrence > skip && occurrence <= skip + limit
          : remaining > 0);
      const announced =
        remaining === undefined
          ? retryAfter
          : String(Math.max(1, Math.ceil(remaining / 1000)));
      return settle(
        Response.json(
          rejected ? { error, ok: false } : { ok: true, ts: STREAM_TS },
          {
            headers:
              rejected && announced !== undefined
                ? { "Retry-After": announced }
                : undefined,
            status: rejected ? status : 200,
          },
        ),
      ).then((response) => {
        calls.push(call);
        if (!rejected) {
          accepted.push(call);
        }
        return response;
      });
    },
    markdown() {
      return markdownChunks().join("");
    },
    markdownChunks,
    methods() {
      return calls.map((call) => call.method);
    },
    taskChunks: () =>
      calls
        .filter((call) => call.method === "chat.appendStream")
        .map((call) => v.parse(appendStreamBody, call.body))
        .filter((body) => v.is(taskAppendBody, body))
        .flatMap((body) => body.chunks),
  };
};

// An injected `sleep` that settles on a later macrotask instead of resolving
// inside the caller, and that reports any Slack call issued while a wait is
// still outstanding: a caller that does not await its wait runs ahead and is
// recorded in `ranAhead`. Simulated time advances when a wait settles, so a
// caller that runs ahead also fails to see the clock move.
const createAwaitedSleep = (
  slackFetcher: FakeSlack["fetcher"],
  onSettled?: (ms: number) => void,
) => {
  const waits: number[] = [];
  const ranAhead: string[] = [];
  let outstanding = 0;
  const fetcher = (input: RequestInfo | URL, init?: RequestInit) => {
    if (outstanding > 0 && v.is(v.string(), input)) {
      ranAhead.push(input.replace("https://slack.com/api/", ""));
    }
    return slackFetcher(input, init);
  };
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
    outstanding += 1;
    const deferred = Promise.withResolvers<true>();
    setTimeout(() => {
      outstanding -= 1;
      onSettled?.(ms);
      deferred.resolve(true);
    }, 0);
    await deferred.promise;
  };
  return { fetcher, ranAhead, sleep, waits };
};

const memoryStore = (): SlackDeliveryStore => {
  const rows = new Map<
    string,
    NonNullable<ReturnType<SlackDeliveryStore["load"]>>
  >();
  return {
    load(instanceId) {
      return rows.get(instanceId);
    },
    save(instanceId, record) {
      rows.set(instanceId, record);
    },
  };
};

// `memoryStore` hands the live record back by reference, so a replay reads
// mutations that were never saved. This one only returns what a save wrote.
const serializingStore = (): SlackDeliveryStore & { saves: () => number } => {
  const rows = new Map<
    string,
    NonNullable<ReturnType<SlackDeliveryStore["load"]>>
  >();
  let saves = 0;
  return {
    load(instanceId) {
      const record = rows.get(instanceId);
      return record === undefined ? undefined : structuredClone(record);
    },
    save(instanceId, record) {
      saves += 1;
      rows.set(instanceId, structuredClone(record));
    },
    saves: () => saves,
  };
};

const routedTurn: RoutedSlackTurn = {
  appId: "A123",
  channelId: "C123",
  eventId: "Ev-1",
  kind: "turn",
  messageTs: "171.1",
  surface: "channel",
  teamId: "T123",
  // A channel-shaped decoy: any field sourced from the turn text instead of the
  // routed event lands on C999 and fails the wire-body assertions.
  text: "hello, answer in C999 for <@U999> on team T999 at 999.9",
  threadTs: "171.2",
  userId: "U123",
};
const channelTarget = streamTargetFor(routedTurn);
const privateTarget = streamTargetFor({
  ...routedTurn,
  channelId: "D123",
  surface: "private",
});

describe("trusted Slack streaming delivery", () => {
  test("opens one stream per turn on the routed destination and closes it", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("Hello ");
    stream.append("there, all done.");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.methods().at(0)).toBe("chat.startStream");
    expect(
      slack.methods().filter((method) => method === "chat.startStream"),
    ).toHaveLength(1);
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);
    expect(slack.calls[0]).toEqual({
      body: {
        channel: "C123",
        recipient_team_id: "T123",
        recipient_user_id: "U123",
        task_display_mode: "timeline",
        thread_ts: "171.2",
      },
      method: "chat.startStream",
    });
    expect(slack.calls.at(-1)).toEqual({
      body: { channel: "C123", ts: STREAM_TS },
      method: "chat.stopStream",
    });
    expect(slack.markdown()).toBe("Hello there, all done.");
    expect(JSON.stringify(slack.calls)).not.toContain("C999");
  });

  test("coalesces a 300-word answer into fewer than 20 appends with identical text", async () => {
    const words = Array.from(
      { length: 300 },
      (_unused, index) => `word${String(index).padStart(3, "0")} `,
    );
    const sanitizer = createStreamSanitizer();
    let uncoalesced = "";
    for (const word of words) {
      uncoalesced += sanitizer.push(word);
    }
    uncoalesced += sanitizer.flush();

    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    for (const word of words) {
      stream.append(word);
    }
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const appends = slack
      .methods()
      .filter((method) => method === "chat.appendStream").length;
    expect(appends).toBe(3);
    expect(COALESCE_CHARS).toBe(1024);
    expect(COALESCE_MS).toBe(300);
    expect(slack.markdown()).toBe(uncoalesced);
  });

  test("withholds a short sanitizer tail until finish", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    await Bun.sleep(400);

    expect(slack.markdownChunks()).toEqual([]);

    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdownChunks()).toEqual(["hello"]);
  });

  test("flushes a mid-size append on the coalesce timer before finish", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    const text = "n".repeat(600);
    stream.append(text);
    await Bun.sleep(400);

    expect(slack.markdownChunks().length).toBeGreaterThan(0);
    expect(slack.markdownChunks()[0]?.length).toBeGreaterThan(0);

    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdown()).toBe(text);
  });

  test("omits the recipient identity outside channels", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(privateTarget, BOT_TOKEN, slack.fetcher);
    stream.append("done");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.calls[0]).toEqual({
      body: {
        channel: "D123",
        task_display_mode: "timeline",
        thread_ts: "171.2",
      },
      method: "chat.startStream",
    });
  });

  test("emits the prefix before flush once the withheld tail is exceeded", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    const text = "n".repeat(600);
    stream.append(text);
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdownChunks().length).toBeGreaterThan(1);
    expect(slack.markdownChunks()[0]?.length).toBeGreaterThan(0);
    expect(slack.markdownChunks()[0]?.length).toBeLessThan(text.length);
    expect(slack.markdown()).toBe(text);
  });

  test("withholds a Slack token split across two deltas", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("credential is xox");
    stream.append("b-1234567890-abcdef done");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdown()).toBe("credential is [secret] done");
    expect(slack.markdown()).not.toContain("xoxb-1234567890-abcdef");
    expect(JSON.stringify(slack.calls)).not.toContain("1234567890");
  });

  test("withholds every sanitizeReply pattern across delta boundaries", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    for (const delta of [
      "  <!chan",
      "nel> ping <",
      "@U999> SIGNING_SEC",
      "RET=oops\n",
      "\n\nend  ",
    ]) {
      stream.append(delta);
    }
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdown()).toBe(
      "ping &lt;@U999> [internal configuration]\n\nend",
    );
  });

  test("withholds a secret name whose assignment lands in the next delta", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("the SECRET ");
    stream.append("=oops done");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdown()).toBe("the [internal configuration] done");
    expect(slack.markdown()).not.toContain("oops");
  });

  test("withholds a JSON secret key split across two deltas", async () => {
    const payload = '{ "password": "hunter2,admin" } done';
    await Promise.all(
      Array.from({ length: payload.length - 1 }, async (_, index) => {
        const offset = index + 1;
        const slack = createFakeSlack();
        const stream = createSlackStream(
          channelTarget,
          BOT_TOKEN,
          slack.fetcher,
        );
        stream.append(payload.slice(0, offset));
        stream.append(payload.slice(offset));
        await stream.finish(SLACK_DELIVERY_FALLBACK);

        expect(JSON.stringify(slack.calls)).not.toContain("hunter2");
        expect(slack.markdown()).toContain("[internal configuration]");
      }),
    );
  });

  test("withholds an escaped JSON secret split across two deltas", async () => {
    const payload = '{ \\"password\\": \\"hunter2\\" } done';
    await Promise.all(
      Array.from({ length: payload.length - 1 }, async (_, index) => {
        const offset = index + 1;
        const slack = createFakeSlack();
        const stream = createSlackStream(
          channelTarget,
          BOT_TOKEN,
          slack.fetcher,
        );
        stream.append(payload.slice(0, offset));
        stream.append(payload.slice(offset));
        await stream.finish(SLACK_DELIVERY_FALLBACK);

        expect(JSON.stringify(slack.calls)).not.toContain("hunter2");
        expect(slack.markdown()).toContain("[internal configuration]");
      }),
    );
  });

  test("redacts pretty-printed secret assignments on the full emitted payload", async () => {
    const cases: [string, string][] = [
      ['{ "password": "hunter2"}', "{ [internal configuration]}"],
      ['{ "api_key": "sk-live-1"},', "{ [internal configuration]},"],
      ['["token": "abc123"]', "[[internal configuration]]"],
    ];
    await Promise.all(
      cases.map(async ([payload, expected]) => {
        const slack = createFakeSlack();
        const stream = createSlackStream(
          channelTarget,
          BOT_TOKEN,
          slack.fetcher,
        );
        stream.append(payload);
        await stream.finish(SLACK_DELIVERY_FALLBACK);
        expect(slack.markdown()).toBe(expected);
      }),
    );
  });

  test("stops the stream once even when the failure path follows a throw", async () => {
    const slack = createFakeSlack({ "chat.stopStream": "channel_not_found" });
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(failure).toEqual(
      new Error("Slack chat.stopStream failed: channel_not_found"),
    );
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);
  });

  test("pins Slack's per-append budget to 12000 characters", () => {
    expect(MAX_SLACK_APPEND_LENGTH).toBe(12_000);
  });

  test("truncates a streamed reply past Slack's safe message length", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("a".repeat(20_000));
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdown()).toHaveLength(3893);
    expect(slack.markdown().endsWith("\n\n(truncated)")).toBe(true);
    expect(
      slack.methods().filter((method) => method === "chat.startStream"),
    ).toHaveLength(1);
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);
    for (const chunk of slack.markdownChunks()) {
      expect(chunk.length).toBeLessThanOrEqual(12_000);
    }
  });

  test("truncation does not emit a lone surrogate when an emoji straddles the cut", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append(`${"a".repeat(3879)}\u{1F600}${"b".repeat(100)}`);
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdown()).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    expect(slack.markdown().endsWith("\n\n(truncated)")).toBe(true);
  });

  test("drops an append once the stream has closed", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);
    const methods = slack.methods();
    stream.append("n".repeat(600));
    await Bun.sleep(400);

    expect(slack.methods()).toEqual(methods);
  });

  test("delivers the fallback when the turn produced no text", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.methods()).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(slack.markdown()).toBe(
      "I finished the turn but produced no reply. Please try again.",
    );
  });

  test("sanitizes the reply text when the turn produced no deltas", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    await stream.finish("<!channel> ship it with xoxb-1234567890-abcdef");

    expect(slack.markdownChunks()).toEqual(["ship it with [secret]"]);
    expect(JSON.stringify(slack.calls)).not.toContain("xoxb-1234567890");
    expect(JSON.stringify(slack.calls)).not.toContain("<!channel>");
  });

  test("replaces a reply text that redacts down to nothing", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    await stream.finish("<!channel><!here>");

    expect(slack.markdownChunks()).toEqual([
      "I could not produce a safe reply for that content.",
    ]);
  });

  test("truncates a reply text past Slack's safe message length", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    await stream.finish("a".repeat(MAX_SLACK_MESSAGE_LENGTH + 200));

    expect(slack.markdown()).toHaveLength(3893);
    expect(slack.markdown().endsWith("\n\n(truncated)")).toBe(true);
  });

  test("reply-text truncation does not emit a lone surrogate when an emoji straddles the cut", async () => {
    const loneSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    const text = `${"a".repeat(3879)}\u{1F600}${"b".repeat(100)}`;
    expect(sanitizeReply(text)).not.toMatch(loneSurrogate);

    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    await stream.finish(text);

    expect(slack.markdown()).not.toMatch(loneSurrogate);
    expect(slack.markdown().endsWith("\n\n(truncated)")).toBe(true);
  });

  test("closes the stream on the failure path", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("partial answer");
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(slack.methods().at(-1)).toBe("chat.stopStream");
    expect(slack.markdownChunks()).toEqual([
      "partial answer",
      "I hit an error before finishing that reply. Please try again.",
    ]);
  });

  test("delivers the failure notice after an append already rejected", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "invalid_chunks" },
      { limit: 1 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("partial answer ");
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(slack.markdownChunks()).toEqual([
      "partial answer",
      "I hit an error before finishing that reply. Please try again.",
    ]);
    expect(slack.acceptedChunks()).toEqual([
      "I hit an error before finishing that reply. Please try again.",
    ]);
    expect(slack.acceptedMethods().at(-1)).toBe("chat.stopStream");
  });

  test("delivers the failure notice once when an append rejects mid-stream", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "invalid_chunks" },
      { limit: 1, skip: 1 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    const prefix = "a".repeat(600);
    stream.append(prefix);
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: invalid_chunks"),
    );
    expect(slack.acceptedChunks()).toEqual([
      "a".repeat(88),
      SLACK_STREAM_FAILURE_NOTICE,
    ]);
    expect(slack.acceptedMethods()).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
  });

  test("stops the stream and reports a rejected append", async () => {
    const slack = createFakeSlack({ "chat.appendStream": "invalid_chunks" });
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: invalid_chunks"),
    );
    expect(slack.methods()).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
  });

  test("retries a Slack rate_limited append until it succeeds", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 3, retryAfter: "0" },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(4);
  });

  test("retries HTTP 429 and 5xx using Retry-After without blocking on backoff", async () => {
    const started = performance.now();
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 1, retryAfter: "0", status: 429 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(2);
    expect(performance.now() - started).toBeLessThan(100);

    const serverError = createFakeSlack(
      { "chat.appendStream": "internal_error" },
      { limit: 1, retryAfter: "0", status: 503 },
    );
    const recovering = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      serverError.fetcher,
    );
    recovering.append("hello");
    await recovering.finish(SLACK_DELIVERY_FALLBACK);

    expect(serverError.acceptedChunks()).toEqual(["hello"]);
  });

  test("pins the honoured wait to one Slack window", () => {
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
    expect(MAX_RETRY_WAIT_MS).toBe(60_000);
  });

  test("honours Retry-After below the cap", () => {
    const response = new Response(null, { headers: { "Retry-After": "1" } });
    expect(retryWait(response, 0, 0)).toEqual({ delayMs: 1000, last: false });
  });

  test("backs off exponentially when Slack announces no window", () => {
    const response = new Response(null);
    expect(retryWait(response, 0, 0)).toEqual({ delayMs: 250, last: false });
    expect(retryWait(response, 1, 0).delayMs).toBe(500);
    expect(retryWait(response, 2, 0).delayMs).toBe(1000);
    expect(retryWait(response, 5, 0).delayMs).toBe(4000);
  });

  test("treats Retry-After: 0 as the zero-second window it announces", () => {
    const response = new Response(null, { headers: { "Retry-After": "0" } });
    expect(retryWait(response, 2, 0)).toEqual({ delayMs: 0, last: false });
  });

  test("backs off between attempts on a 5xx that carries no Retry-After", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "internal_error" },
      { limit: 3, status: 503 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher);
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(sleeper.waits).toEqual([250, 500, 1000]);
    expect(sleeper.ranAhead).toEqual([]);
  });

  test("spends what the phase can fund and marks that wait its last", () => {
    const response = new Response(null, { headers: { "Retry-After": "90" } });
    expect(retryWait(response, 0, 0)).toEqual({ delayMs: 60_000, last: true });
    expect(retryWait(response, 1, 45_000)).toEqual({
      delayMs: 15_000,
      last: true,
    });
    expect(retryWait(response, 2, 60_000)).toEqual({ delayMs: 0, last: true });
  });

  test("keeps waiting through each announced window within the phase budget", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 3, retryAfter: "2", status: 429 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher);
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(sleeper.waits).toEqual([2000, 2000, 2000]);
    expect(sleeper.ranAhead).toEqual([]);
    expect(sleeper.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      MAX_RETRY_WAIT_MS,
    );
  });

  test("waits for every retry it requests, including a zero-second one", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 1, retryAfter: "0", status: 429 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher);
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(sleeper.waits).toEqual([0]);
    expect(sleeper.ranAhead).toEqual([]);
  });

  test("gives chat.stopStream the closing window, not the spent content one", async () => {
    const slack = createFakeSlack(
      {
        "chat.appendStream": "rate_limited",
        "chat.stopStream": "rate_limited",
      },
      { limit: 2, retryAfter: "30", status: 429 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher);
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(slack.acceptedMethods().at(-1)).toBe("chat.stopStream");
    expect(sleeper.waits).toEqual([30_000, 30_000, 30_000, 30_000]);
    expect(sleeper.ranAhead).toEqual([]);
  });

  test("waits out the window that blocked the append instead of giving up inside it", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { status: 429, windowMs: 7000 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    const started = performance.now();
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);
    const elapsed = performance.now() - started;

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(elapsed).toBeGreaterThanOrEqual(6500);
    expect(elapsed).toBeLessThan(11_000);
  }, 20_000);

  test("stops the phase once Slack asks for more than its budget can fund", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { retryAfter: "90", status: 429 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher);
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(new Error("Slack chat.appendStream failed: 429"));
    expect(sleeper.waits).toEqual([MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS]);
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(2);
    expect(sleeper.ranAhead).toEqual([]);
  });

  test("honours the announced window up to the phase budget and no further", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 3, retryAfter: "60", status: 429 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher);
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(new Error("Slack chat.appendStream failed: 429"));
    expect(slack.acceptedChunks()).toEqual([SLACK_STREAM_FAILURE_NOTICE]);
    expect(sleeper.waits).toEqual([MAX_RETRY_AFTER_MS, 0, MAX_RETRY_AFTER_MS]);
    expect(sleeper.ranAhead).toEqual([]);
  });

  test("gives the failure notice its own window after the stream spends the content budget", async () => {
    const clock = { now: 0 };
    const slack = createFakeSlack(
      { "chat.startStream": "rate_limited" },
      { now: () => clock.now, status: 429, windowMs: 65_000 },
    );
    const sleeper = createAwaitedSleep(slack.fetcher, (ms) => {
      clock.now += ms;
    });
    const stream = createSlackStream(
      channelTarget,
      BOT_TOKEN,
      sleeper.fetcher,
      sleeper.sleep,
    );
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(new Error("Slack chat.startStream failed: 429"));
    expect(slack.acceptedChunks()).toEqual([SLACK_STREAM_FAILURE_NOTICE]);
    expect(slack.acceptedMethods().at(-1)).toBe("chat.stopStream");
    expect(sleeper.waits.filter((ms) => ms > 0)).toEqual([60_000, 5000]);
    expect(sleeper.ranAhead).toEqual([]);
    expect(sleeper.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      MAX_RETRY_WAIT_MS * 2,
    );
  });

  test("stops retrying a retryable Slack error after four attempts", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { retryAfter: "0", status: 429 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(new Error("Slack chat.appendStream failed: 429"));
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(8);
  });

  test("fails fast on a non-retryable Slack error", async () => {
    const slack = createFakeSlack({ "chat.appendStream": "channel_not_found" });
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: channel_not_found"),
    );
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(2);
  });

  test("retries a Slack internal_error at HTTP 200 until it succeeds", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "internal_error" },
      { limit: 1, retryAfter: "0", status: 200 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.acceptedChunks()).toEqual(["hello"]);
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(2);
  });

  test("fails fast on channel_not_found at HTTP 200", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "channel_not_found" },
      { status: 200 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: channel_not_found"),
    );
    expect(
      slack.methods().filter((method) => method === "chat.appendStream"),
    ).toHaveLength(2);
  });
});

describe("Slack task updates", () => {
  test("orders task chunks against the reply text they interleave with", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("Looking it up. ");
    stream.task({ id: "call-1", status: "in_progress", title: "search_docs" });
    stream.task({
      id: "call-1",
      output: "three matches",
      status: "complete",
      title: "search_docs",
    });
    stream.append("Found three.");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(
      slack.methods().filter((method) => method === "chat.startStream"),
    ).toHaveLength(1);
    expect(
      slack.calls
        .filter((call) => call.method === "chat.appendStream")
        .map((call) => JSON.stringify(call.body)),
    ).toEqual([
      JSON.stringify({
        channel: "C123",
        chunks: [
          {
            id: "call-1",
            status: "in_progress",
            title: "search_docs",
            type: "task_update",
          },
        ],
        ts: STREAM_TS,
      }),
      JSON.stringify({
        channel: "C123",
        chunks: [
          {
            id: "call-1",
            output: "three matches",
            status: "complete",
            title: "search_docs",
            type: "task_update",
          },
        ],
        ts: STREAM_TS,
      }),
      JSON.stringify({
        channel: "C123",
        markdown_text: "Looking it up. Found three.",
        ts: STREAM_TS,
      }),
    ]);
  });

  test("names a task whose title redacts down to nothing", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({ id: "call-1", status: "in_progress", title: "<!channel>" });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.taskChunks()).toEqual([
      {
        id: "call-1",
        status: "in_progress",
        title: SLACK_TASK_FALLBACK_TITLE,
        type: "task_update",
      },
    ]);
  });

  test("spends Slack's 256-character budget on the whole chunk", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({
      id: "call-1",
      output: "b".repeat(MAX_SLACK_TASK_CHUNK_LENGTH * 2),
      status: "complete",
      title: "search_docs",
    });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const [wire] = slack.taskChunks();
    const chunk = v.parse(
      v.object({ output: v.string(), title: v.string() }),
      wire,
    );
    // Slack documents 256 for the serialized chunk. Pin the literal so a
    // widened or narrowed constant cannot keep this test green.
    expect(MAX_SLACK_TASK_CHUNK_LENGTH).toBe(256);
    expect(encodedLength(JSON.stringify(wire))).toBe(256);
    expect(chunk.title).toBe("search_docs");
    expect(chunk.output.length).toBeLessThan(256);
  });

  test("drops the output rather than overflow on an oversized title", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({
      id: "call-1",
      output: "b".repeat(MAX_SLACK_TASK_CHUNK_LENGTH),
      status: "complete",
      title: "a".repeat(MAX_SLACK_TASK_CHUNK_LENGTH),
    });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const [wire] = slack.taskChunks();
    const chunk = v.parse(
      v.object({ output: v.optional(v.string()), title: v.string() }),
      wire,
    );
    expect(encodedLength(JSON.stringify(wire))).toBeLessThanOrEqual(
      MAX_SLACK_TASK_CHUNK_LENGTH,
    );
    expect(chunk.output).toBeUndefined();
    expect(chunk.title.length).toBeGreaterThan(0);
  });

  test("keeps a usable title when the id alone eats the budget", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({
      id: "call-".concat("9".repeat(MAX_SLACK_TASK_CHUNK_LENGTH)),
      output: "three matches",
      status: "complete",
      title: "search_docs",
    });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const [wire] = slack.taskChunks();
    const chunk = v.parse(
      v.object({ id: v.string(), title: v.string() }),
      wire,
    );
    // `title` is required by Slack, so the opaque id yields the budget before
    // the chunk is ever allowed to go out titleless or oversized.
    expect(encodedLength(JSON.stringify(wire))).toBeLessThanOrEqual(
      MAX_SLACK_TASK_CHUNK_LENGTH,
    );
    expect(chunk.title).toBe(SLACK_TASK_FALLBACK_TITLE);
    expect(chunk.id.startsWith("call-")).toBe(true);
  });

  test("clamps a short title plus a long id to Slack's 256-byte budget", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({
      id: "toolu_".concat("0".repeat(300)),
      status: "in_progress",
      title: "ls",
    });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const [wire] = slack.taskChunks();
    const chunk = v.parse(
      v.object({ id: v.string(), title: v.string() }),
      wire,
    );
    expect(MAX_SLACK_TASK_CHUNK_LENGTH).toBe(256);
    expect(encodedLength(JSON.stringify(wire))).toBeLessThanOrEqual(256);
    expect(chunk.title).toBe(SLACK_TASK_FALLBACK_TITLE);
    expect(chunk.id.startsWith("toolu_")).toBe(true);
  });

  test("spends the budget in wire bytes, not UTF-16 units", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({
      id: "call-1",
      output: "\u{1F600}".repeat(200),
      status: "complete",
      title: "search_docs",
    });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const [wire] = slack.taskChunks();
    const chunk = v.parse(v.object({ output: v.string() }), wire);
    // Each emoji is two UTF-16 units but four bytes, so a unit-counted budget
    // would let roughly twice the payload through.
    expect(encodedLength(JSON.stringify(wire))).toBeLessThanOrEqual(
      MAX_SLACK_TASK_CHUNK_LENGTH,
    );
    expect(JSON.stringify(wire).length).toBeLessThan(
      MAX_SLACK_TASK_CHUNK_LENGTH,
    );
    expect(chunk.output).not.toContain("\uD83D");
    expect(chunk.output.replaceAll("\u{1F600}", "")).toBe("");
  });

  test("never emits an invalid chunk, whatever the tool produced", async () => {
    // `.length` counts UTF-16 units while Slack measures the serialized chunk,
    // so surrogate pairs and escape-heavy text are the cases that separate a
    // budget that holds from one that only looks like it does.
    const texts = [
      "",
      " ".repeat(400),
      "a".repeat(1000),
      "e\u0301".repeat(400),
      "\u{1F600}".repeat(300),
      '"\\\n\t'.repeat(300),
      "\u4E2D\u6587".repeat(300),
    ];
    const ids = [
      "",
      "call-1",
      "x".repeat(200),
      "y".repeat(300),
      '"\\'.repeat(50),
    ];
    const titles = [
      "search_docs",
      "ls",
      "t".repeat(400),
      "\u{1F600}".repeat(200),
      "<!channel>",
    ];

    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    for (const id of ids) {
      for (const title of titles) {
        for (const output of texts) {
          stream.task({ id, output, status: "complete", title });
        }
      }
    }
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const wire = slack.taskChunks();
    expect(wire).toHaveLength(ids.length * titles.length * texts.length);
    for (const chunk of wire) {
      const parsed = v.parse(
        v.object({ id: v.string(), title: v.string() }),
        chunk,
      );
      expect(encodedLength(JSON.stringify(chunk))).toBeLessThanOrEqual(
        MAX_SLACK_TASK_CHUNK_LENGTH,
      );
      expect(parsed.title).not.toBe("");
      expect(parsed.id).not.toBe("");
    }
  });

  test("omits an output that carries nothing once sanitized", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({
      id: "call-1",
      output: "<!here>",
      status: "complete",
      title: "search_docs",
    });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.taskChunks()).toEqual([
      {
        id: "call-1",
        status: "complete",
        title: "search_docs",
        type: "task_update",
      },
    ]);
  });

  test("still owes a reply when the turn only ran tools", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({ id: "call-1", status: "complete", title: "search_docs" });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdownChunks()).toEqual([SLACK_DELIVERY_FALLBACK]);
  });

  test("reports a rejected task chunk and stops the stream once", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "invalid_chunks" },
      { limit: 1 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({ id: "call-1", status: "in_progress", title: "search_docs" });
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: invalid_chunks"),
    );
    expect(slack.acceptedChunks()).toEqual([SLACK_STREAM_FAILURE_NOTICE]);
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);
  });

  test("drops a task update once the stream has closed", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    await stream.finish(SLACK_DELIVERY_FALLBACK);
    const calls = slack.calls.length;
    stream.task({ id: "late", status: "complete", title: "search_docs" });
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(slack.calls).toHaveLength(calls);
    expect(
      slack.taskChunks().map((chunk) => v.parse(taskChunk, chunk).id),
    ).not.toContain("late");
  });

  test("emits a one-character id when the runtime supplied none", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.task({ id: "", status: "complete", title: "search_docs" });
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.taskChunks()).toEqual([
      {
        id: "_",
        status: "complete",
        title: "search_docs",
        type: "task_update",
      },
    ]);
  });
});

const repeatingAlphabet = (length: number): string =>
  Array.from({ length }, (_, index) =>
    String.fromCodePoint(97 + (index % 26)),
  ).join("");

describe("stream sanitizer cutter", () => {
  test("the withheld tail is 512 characters", () => {
    expect(STREAM_TAIL_LENGTH).toBe(512);
  });

  test("the longest secret-assignment match is shorter than the withheld tail", () => {
    const name = `\\"'${"A".repeat(64)}SIGNING_SECRET${"A".repeat(64)}\\""`;
    const value = `\\"${"x".repeat(200)}\\"`;
    const assignment = (spaces: number) =>
      `${name}${" ".repeat(spaces)}=${" ".repeat(spaces)}${value}`;
    let maxSpaces = 0;
    for (let spaces = 0; spaces <= 800; spaces += 1) {
      if (sanitizeReply(assignment(spaces)) === "[internal configuration]") {
        maxSpaces = spaces;
      }
    }
    const longest = assignment(maxSpaces);
    expect(longest.length).toBe(385);
    expect(385).toBeLessThan(512);
  });

  test("4000 space-free single-character pushes finish under a second and emit before flush", () => {
    const text = repeatingAlphabet(4000);
    const sanitizer = createStreamSanitizer();
    const started = performance.now();
    const emissions: string[] = [];
    const collect = (piece: string) => {
      if (piece !== "") {
        emissions.push(piece);
      }
    };
    for (const char of text) {
      collect(sanitizer.push(char));
    }
    const elapsed = performance.now() - started;
    collect(sanitizer.flush());
    expect(elapsed).toBeLessThan(1000);
    const expected = Array.from(
      { length: 3488 },
      (_, index) => text[index] ?? "",
    );
    expected.push(text.slice(3488));
    expect(emissions).toEqual(expected);
  });

  test("400 Japanese characters produce more than one emission", () => {
    const text = Array.from({ length: 912 }, (_, index) =>
      String.fromCodePoint(0x30_41 + (index % 86)),
    ).join("");
    const sanitizer = createStreamSanitizer();
    const emissions: string[] = [];
    const collect = (piece: string) => {
      if (piece !== "") {
        emissions.push(piece);
      }
    };
    collect(sanitizer.push(text));
    collect(sanitizer.flush());
    expect(emissions).toEqual([text.slice(0, 400), text.slice(400)]);
  });

  test("a 3-tail unique push emits prefix blocks then the withheld tail in order", () => {
    const text = repeatingAlphabet(1536);
    const sanitizer = createStreamSanitizer();
    const emissions: string[] = [];
    const collect = (piece: string) => {
      if (piece !== "") {
        emissions.push(piece);
      }
    };
    collect(sanitizer.push(text));
    collect(sanitizer.flush());
    expect(emissions).toEqual([text.slice(0, 1024), text.slice(1024)]);
  });

  test("redacts an accidental configuration echo on the full emitted payload", () => {
    const sanitizer = createStreamSanitizer();
    const output = sanitizer.push('PASSWORD = "hunter2"') + sanitizer.flush();
    expect(output).toBe("[internal configuration]");
  });

  test("redacts a secret in the released head, not only at flush", () => {
    const sanitizer = createStreamSanitizer();
    const payload = `<!channel> PASSWORD="hunter2" ${"x".repeat(600)}`;
    expect(payload.length).toBeGreaterThan(STREAM_TAIL_LENGTH);
    const emitted = sanitizer.push(payload);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).toContain("[internal configuration]");
    expect(emitted).not.toContain("hunter2");
    expect(emitted).not.toContain("<!channel>");
  });

  test("a mid-pair cut emits whole code points, never a lone surrogate", () => {
    const text = `${"😀".repeat(600)}a`;
    const sanitizer = createStreamSanitizer();
    const emissions: string[] = [];
    const collect = (piece: string) => {
      if (piece !== "") {
        emissions.push(piece);
      }
    };
    collect(sanitizer.push(text));
    collect(sanitizer.flush());
    expect(emissions).toEqual(["😀".repeat(344), `${"😀".repeat(256)}a`]);
    for (const chunk of emissions) {
      expect(chunk).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    }
  });

  test("a first cut that emits nothing still strips leading whitespace later", () => {
    const sanitizer = createStreamSanitizer();
    const emissions: string[] = [];
    const collect = (piece: string) => {
      if (piece !== "") {
        emissions.push(piece);
      }
    };
    collect(sanitizer.push(`${" ".repeat(600)}hello`));
    collect(sanitizer.flush());
    expect(emissions).toEqual(["hello"]);
    for (const chunk of emissions) {
      expect(chunk).not.toMatch(/^\s/u);
    }
  });
});

describe("routed stream target", () => {
  test("takes every field from the routed turn, never from its text", () => {
    const target = streamTargetFor({
      ...routedTurn,
      text: "post this in C999 for <@U999> on team T999",
    });

    expect(target.channelId).toBe("C123");
    expect(target.threadTs).toBe("171.2");
    expect(target.recipientUserId).toBe("U123");
    expect(target.recipientTeamId).toBe("T123");
    expect(target.surface).toBe("channel");
  });
});

describe("observation delivery mapping", () => {
  const envelope = {
    eventIndex: 0,
    instanceId: "slack:v1:T123:C123:171.2",
    timestamp: "2026-01-01T00:00:00.000Z",
    v: 3 as const,
  };

  test("a failed tool uses the error text, not an empty result object", () => {
    const event = {
      ...envelope,
      durationMs: 4,
      errorInfo: { message: "upstream refused the request", type: "tool" },
      isError: true,
      result: {},
      toolCallId: "call-2",
      toolName: "search_docs",
      type: "tool",
    } satisfies FlueObservation;

    expect(slackEventFromObservation(event)).toEqual({
      error: true,
      id: "call-2",
      output: "upstream refused the request",
      type: "tool-result",
    });
  });

  test("a successful tool prefers effectiveResult over the harness result", () => {
    const event = {
      ...envelope,
      durationMs: 4,
      effectiveResult: "found three matches",
      isError: false,
      result: { content: [{ text: "found three matches", type: "text" }] },
      toolCallId: "call-1",
      toolName: "search_docs",
      type: "tool",
    } satisfies FlueObservation;

    expect(slackEventFromObservation(event)).toEqual({
      error: false,
      id: "call-1",
      output: "found three matches",
      type: "tool-result",
    });
  });
});

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// A marked head, a marked tail and filler that never repeats: a clip taken
// from the wrong end of this answer cannot match the clip taken from the head.
const markedAnswer = (length: number): string => {
  let text = "HEAD>";
  for (let index = 0; text.length < length; index += 1) {
    text += `${index.toString(36)}-`;
  }
  return `${text.slice(0, length - 5)}<TAIL`;
};

describe("durable Slack delivery", () => {
  test("replays durable tool events in record order and the reply text exactly once", async () => {
    const slack = createFakeSlack();
    const store = memoryStore();
    const preamble = "n".repeat(600);
    openSlackDelivery(
      store,
      "i1",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    evictLiveSlackDelivery("i1");
    applySlackDeliveryEvent(store, "i1", { text: preamble, type: "text" });
    applySlackDeliveryEvent(store, "i1", {
      id: "call-1",
      name: "search_docs",
      type: "tool-start",
    });
    applySlackDeliveryEvent(store, "i1", {
      error: false,
      id: "call-1",
      output: "found three",
      type: "tool-result",
    });
    applySlackDeliveryEvent(store, "i1", { text: "Done.", type: "text" });

    await finishSlackDelivery(store, "i1", BOT_TOKEN, slack.fetcher);

    expect(slack.taskChunks()).toEqual([
      {
        id: "call-1",
        status: "in_progress",
        title: "search_docs",
        type: "task_update",
      },
      {
        id: "call-1",
        output: "found three",
        status: "complete",
        title: "search_docs",
        type: "task_update",
      },
    ]);
    expect(slack.markdownChunks()).toEqual([`${preamble}Done.`]);
    expect(
      slack.methods().filter((method) => method === "chat.startStream"),
    ).toHaveLength(1);
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);
  });

  test("tells the user and closes the record when the durable replay fails", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "channel_not_found" },
      { limit: 1 },
    );
    const store = memoryStore();
    openSlackDelivery(
      store,
      "i1",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    evictLiveSlackDelivery("i1");
    applySlackDeliveryEvent(store, "i1", {
      id: "call-1",
      name: "search_docs",
      type: "tool-start",
    });
    applySlackDeliveryEvent(store, "i1", { text: "hello", type: "text" });

    await finishSlackDelivery(store, "i1", BOT_TOKEN, slack.fetcher);

    expect(slack.acceptedChunks()).toEqual([SLACK_STREAM_FAILURE_NOTICE]);
    expect(
      slack.methods().filter((method) => method === "chat.startStream"),
    ).toHaveLength(1);
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);

    const calls = slack.calls.length;
    await finishSlackDelivery(store, "i1", BOT_TOKEN, slack.fetcher);
    expect(slack.calls).toHaveLength(calls);
  });

  test("appends the failure notice from the durable record once the live stream is evicted", async () => {
    const slack = createFakeSlack();
    const store = memoryStore();
    openSlackDelivery(
      store,
      "i1",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    evictLiveSlackDelivery("i1");
    applySlackDeliveryEvent(store, "i1", {
      id: "call-1",
      name: "search_docs",
      type: "tool-start",
    });
    applySlackDeliveryEvent(store, "i1", {
      text: "partial answer",
      type: "text",
    });

    await failSlackDelivery(store, "i1", BOT_TOKEN, slack.fetcher);

    expect(slack.acceptedChunks()).toEqual([
      "partial answer",
      SLACK_STREAM_FAILURE_NOTICE,
    ]);
    expect(
      slack.methods().filter((method) => method === "chat.stopStream"),
    ).toHaveLength(1);
    expect(store.load("i1")?.closed).toBe(true);
  });

  test("does not grow the durable record when an event arrives after finish", async () => {
    const slack = createFakeSlack();
    const store = memoryStore();
    openSlackDelivery(
      store,
      "i1",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    applySlackDeliveryEvent(store, "i1", { text: "hello", type: "text" });

    await finishSlackDelivery(store, "i1", BOT_TOKEN, slack.fetcher);
    const closed = JSON.stringify(store.load("i1"));

    applySlackDeliveryEvent(store, "i1", { text: " and more", type: "text" });
    applySlackDeliveryEvent(store, "i1", {
      id: "call-2",
      name: "later",
      type: "tool-start",
    });

    expect(JSON.stringify(store.load("i1"))).toBe(closed);
    expect(store.load("i1")?.closed).toBe(true);
  });

  test("keeps the durable record bounded and merged while a long reply streams", async () => {
    const slack = createFakeSlack();
    const store = memoryStore();
    openSlackDelivery(
      store,
      "i1",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    for (let index = 0; index < 2500; index += 1) {
      applySlackDeliveryEvent(store, "i1", { text: "abcd", type: "text" });
    }
    await finishSlackDelivery(store, "i1", BOT_TOKEN, slack.fetcher);

    const record = store.load("i1");
    expect(record?.replyText).toHaveLength(
      MAX_SLACK_MESSAGE_LENGTH + STREAM_TAIL_LENGTH,
    );
    expect(
      record?.events.filter((event) => event.type === "text"),
    ).toHaveLength(1);
  });

  test("replays a long reply as the same text the live stream sends", async () => {
    const answer = markedAnswer(6007);
    const expected = `${answer.slice(0, MAX_SLACK_MESSAGE_LENGTH - 20)}\n\n(truncated)`;
    const deltas = Array.from(
      { length: Math.ceil(answer.length / 997) },
      (_unused, index) => answer.slice(index * 997, index * 997 + 997),
    );
    const liveSlack = createFakeSlack();
    const liveStore = serializingStore();
    openSlackDelivery(
      liveStore,
      "live",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      liveSlack.fetcher,
    );
    for (const text of deltas) {
      applySlackDeliveryEvent(liveStore, "live", { text, type: "text" });
    }
    await finishSlackDelivery(liveStore, "live", BOT_TOKEN, liveSlack.fetcher);

    const replaySlack = createFakeSlack();
    const replayStore = serializingStore();
    openSlackDelivery(
      replayStore,
      "replay",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      replaySlack.fetcher,
    );
    evictLiveSlackDelivery("replay");
    for (const text of deltas) {
      applySlackDeliveryEvent(replayStore, "replay", { text, type: "text" });
    }
    await finishSlackDelivery(
      replayStore,
      "replay",
      BOT_TOKEN,
      replaySlack.fetcher,
    );

    expect(expected).toContain("HEAD>");
    expect(expected).not.toContain("<TAIL");
    expect(liveSlack.markdown()).toBe(expected);
    expect(replaySlack.markdown()).toBe(expected);
    expect(replayStore.load("replay")?.replyText).toBe(
      answer.slice(0, MAX_SLACK_MESSAGE_LENGTH + STREAM_TAIL_LENGTH),
    );
  });

  test("does not leave a lone surrogate when a pair straddles the durable cap", async () => {
    const cap = MAX_SLACK_MESSAGE_LENGTH + STREAM_TAIL_LENGTH;
    const head = "a".repeat(cap - 1);
    const slack = createFakeSlack();
    const store = serializingStore();
    openSlackDelivery(
      store,
      "surrogate",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    applySlackDeliveryEvent(store, "surrogate", {
      text: `${head}\uD83D`,
      type: "text",
    });
    applySlackDeliveryEvent(store, "surrogate", {
      text: "\uDE00 and the rest of the answer",
      type: "text",
    });
    await finishSlackDelivery(store, "surrogate", BOT_TOKEN, slack.fetcher);

    const record = store.load("surrogate");
    expect(record?.replyText).toBe(head);
    expect(record?.replyText).not.toMatch(LONE_SURROGATE);
    expect(record?.events.find((event) => event.type === "text")?.text).toBe(
      head,
    );
  });

  test("delivers the buffered text after an eviction instead of the fallback", async () => {
    const answer = "a".repeat(50);
    const slack = createFakeSlack();
    const store = serializingStore();
    openSlackDelivery(
      store,
      "evicted",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    applySlackDeliveryEvent(store, "evicted", { text: answer, type: "text" });
    evictLiveSlackDelivery("evicted");
    await finishSlackDelivery(store, "evicted", BOT_TOKEN, slack.fetcher);

    expect(slack.markdown()).toBe(answer);
    expect(slack.markdown()).not.toContain(SLACK_DELIVERY_FALLBACK);
  });

  test("saves the coalesced text when the flush timer fires", async () => {
    const answer = "b".repeat(50);
    const slack = createFakeSlack();
    const store = serializingStore();
    openSlackDelivery(
      store,
      "timer",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    const saves = store.saves();
    applySlackDeliveryEvent(store, "timer", { text: answer, type: "text" });

    expect(store.load("timer")?.replyText).toBe("");
    await Bun.sleep(COALESCE_MS + 100);
    expect(store.saves()).toBe(saves + 1);
    expect(store.load("timer")?.replyText).toBe(answer);

    evictLiveSlackDelivery("timer");
    await finishSlackDelivery(store, "timer", BOT_TOKEN, slack.fetcher);
    expect(slack.markdown()).toBe(answer);
  });

  test("anchors the flush timer to the first pending delta, not the last", async () => {
    const slack = createFakeSlack();
    const store = serializingStore();
    openSlackDelivery(
      store,
      "anchor",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    applySlackDeliveryEvent(store, "anchor", { text: "one ", type: "text" });
    await Bun.sleep(120);
    applySlackDeliveryEvent(store, "anchor", { text: "two ", type: "text" });
    await Bun.sleep(120);
    applySlackDeliveryEvent(store, "anchor", { text: "three", type: "text" });
    await Bun.sleep(COALESCE_MS - 120);

    expect(store.load("anchor")?.replyText).toBe("one two three");

    evictLiveSlackDelivery("anchor");
    await finishSlackDelivery(store, "anchor", BOT_TOKEN, slack.fetcher);
  });

  test("delivers the same reply text on the durable finish and fail paths", async () => {
    const events: SlackDeliveryEvent[] = [
      { text: "partial ", type: "text" },
      { id: "call-1", name: "search_docs", type: "tool-start" },
      { text: "answer", type: "text" },
    ];
    const finishSlack = createFakeSlack();
    const finishStore = serializingStore();
    openSlackDelivery(
      finishStore,
      "finished",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      finishSlack.fetcher,
    );
    evictLiveSlackDelivery("finished");
    const failSlack = createFakeSlack();
    const failStore = serializingStore();
    openSlackDelivery(
      failStore,
      "failed",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      failSlack.fetcher,
    );
    evictLiveSlackDelivery("failed");
    for (const event of events) {
      applySlackDeliveryEvent(finishStore, "finished", event);
      applySlackDeliveryEvent(failStore, "failed", event);
    }

    await finishSlackDelivery(
      finishStore,
      "finished",
      BOT_TOKEN,
      finishSlack.fetcher,
    );
    await failSlackDelivery(failStore, "failed", BOT_TOKEN, failSlack.fetcher);

    expect(finishSlack.acceptedChunks()).toEqual(["partial answer"]);
    expect(failSlack.acceptedChunks()).toEqual([
      "partial answer",
      SLACK_STREAM_FAILURE_NOTICE,
    ]);
  });

  test("does not throw or double-post when finish hits a Slack error and is retried", async () => {
    const slack = createFakeSlack({ "chat.stopStream": "channel_not_found" });
    const store = memoryStore();
    openSlackDelivery(
      store,
      "i1",
      slackDeliveryBinding(channelTarget),
      BOT_TOKEN,
      slack.fetcher,
    );
    applySlackDeliveryEvent(store, "i1", { text: "hello", type: "text" });
    await finishSlackDelivery(store, "i1", BOT_TOKEN);
    const calls = slack.calls.length;
    await finishSlackDelivery(store, "i1", BOT_TOKEN);
    evictLiveSlackDelivery();

    expect(slack.calls).toHaveLength(calls);
    expect(
      slack.methods().filter((method) => method === "chat.startStream"),
    ).toHaveLength(1);
  });
});
