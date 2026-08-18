import { describe, expect, test } from "bun:test";
import {
  createSlackStream,
  MAX_SLACK_APPEND_LENGTH,
  MAX_SLACK_MESSAGE_LENGTH,
  MAX_SLACK_TASK_CHUNK_LENGTH,
  SLACK_DELIVERY_FALLBACK,
  SLACK_STREAM_FAILURE_NOTICE,
  SLACK_TASK_FALLBACK_TITLE,
  streamTargetFor,
} from "@agentic-slack/core";
import type { RoutedSlackTurn } from "@agentic-slack/core";
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
  markdown_text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_SLACK_APPEND_LENGTH),
  ),
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
// rejected, so a transient mid-stream failure can be staged.
interface FakeSlackFailures {
  limit?: number;
  skip?: number;
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
  { limit = Number.POSITIVE_INFINITY, skip = 0 }: FakeSlackFailures = {},
): FakeSlack => {
  const calls: SlackCall[] = [];
  const accepted: SlackCall[] = [];
  const seen = new Map<string, number>();
  const settle = createLifoSettler<Response>();
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
      const rejected =
        error !== undefined && occurrence > skip && occurrence <= skip + limit;
      return settle(
        Response.json(
          rejected ? { error, ok: false } : { ok: true, ts: STREAM_TS },
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

  test("emits one append per delta instead of a single buffered flush", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("credential is xox");
    stream.append("b-1234567890-abcdef done");
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    expect(slack.markdownChunks()).toEqual([
      "credential is ",
      "[secret] ",
      "done",
    ]);
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

  test("splits an oversized reply into Slack-sized appends", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("a".repeat(MAX_SLACK_APPEND_LENGTH + 500));
    await stream.finish(SLACK_DELIVERY_FALLBACK);

    const appends = slack.calls.filter(
      (call) => call.method === "chat.appendStream",
    );
    expect(appends).toHaveLength(2);
    expect(slack.markdown()).toHaveLength(MAX_SLACK_APPEND_LENGTH + 500);
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

  test("closes the stream on the failure path", async () => {
    const slack = createFakeSlack();
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("partial answer");
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(slack.methods().at(-1)).toBe("chat.stopStream");
    expect(slack.markdownChunks()).toEqual([
      "partial ",
      "answer",
      "I hit an error before finishing that reply. Please try again.",
    ]);
  });

  test("delivers the failure notice after an append already rejected", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 1 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("partial answer ");
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(slack.markdownChunks()).toEqual([
      "partial ",
      "I hit an error before finishing that reply. Please try again.",
    ]);
    expect(slack.acceptedChunks()).toEqual([
      "I hit an error before finishing that reply. Please try again.",
    ]);
    expect(slack.acceptedMethods().at(-1)).toBe("chat.stopStream");
  });

  test("delivers the failure notice once when an append rejects mid-stream", async () => {
    const slack = createFakeSlack(
      { "chat.appendStream": "rate_limited" },
      { limit: 1, skip: 1 },
    );
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello world ");
    stream.append("more text ");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);

    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: rate_limited"),
    );
    expect(slack.acceptedChunks()).toEqual([
      "hello ",
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
    const slack = createFakeSlack({ "chat.appendStream": "rate_limited" });
    const stream = createSlackStream(channelTarget, BOT_TOKEN, slack.fetcher);
    stream.append("hello");
    let failure: unknown;
    try {
      await stream.finish(SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toEqual(
      new Error("Slack chat.appendStream failed: rate_limited"),
    );
    expect(slack.methods()).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
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
        markdown_text: "Looking it ",
        ts: STREAM_TS,
      }),
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
        markdown_text: "up. Found ",
        ts: STREAM_TS,
      }),
      JSON.stringify({
        channel: "C123",
        markdown_text: "three.",
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
