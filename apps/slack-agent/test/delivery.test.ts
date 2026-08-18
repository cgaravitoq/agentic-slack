import { describe, expect, test } from "bun:test";
import {
  createSlackStream,
  MAX_SLACK_APPEND_LENGTH,
  MAX_SLACK_MESSAGE_LENGTH,
  SLACK_DELIVERY_FALLBACK,
  SLACK_STREAM_FAILURE_NOTICE,
  streamTargetFor,
} from "@agentic-slack/core";
import type { RoutedSlackTurn } from "@agentic-slack/core";
import * as v from "valibot";

const BOT_TOKEN = "xoxb-trusted-token";
const STREAM_TS = "171.9";

// Strict objects: an extra key, a wrapper envelope or a renamed field fails the
// parse, so the fake only accepts Slack's exact streaming wire shape.
const startStreamBody = v.strictObject({
  channel: v.string(),
  thread_ts: v.string(),
});
const channelStartStreamBody = v.strictObject({
  channel: v.string(),
  recipient_team_id: v.string(),
  recipient_user_id: v.string(),
  thread_ts: v.string(),
});
const appendStreamBody = v.strictObject({
  channel: v.string(),
  markdown_text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_SLACK_APPEND_LENGTH),
  ),
  ts: v.string(),
});
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
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

// `skip` occurrences of a method are answered ok before the next `limit` are
// rejected, so a transient mid-stream failure can be staged.
interface FakeSlackFailures {
  limit?: number;
  skip?: number;
}

const createFakeSlack = (
  failures: Partial<Record<string, string>> = {},
  { limit = Number.POSITIVE_INFINITY, skip = 0 }: FakeSlackFailures = {},
): FakeSlack => {
  const calls: SlackCall[] = [];
  const accepted: SlackCall[] = [];
  const seen = new Map<string, number>();
  const chunksOf = (recorded: SlackCall[]) =>
    recorded
      .filter((call) => call.method === "chat.appendStream")
      .map((call) => v.parse(appendStreamBody, call.body).markdown_text);
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
      calls.push(call);
      const error = failures[method];
      const occurrence = (seen.get(method) ?? 0) + 1;
      seen.set(method, occurrence);
      if (
        error !== undefined &&
        occurrence > skip &&
        occurrence <= skip + limit
      ) {
        return Promise.resolve(Response.json({ error, ok: false }));
      }
      accepted.push(call);
      return Promise.resolve(Response.json({ ok: true, ts: STREAM_TS }));
    },
    markdown() {
      return markdownChunks().join("");
    },
    markdownChunks,
    methods() {
      return calls.map((call) => call.method);
    },
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
      body: { channel: "D123", thread_ts: "171.2" },
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
