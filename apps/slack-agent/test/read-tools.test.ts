import { expect, mock, spyOn, test } from "bun:test";
import type {
  AgentAppendMessage,
  AgentStartContext,
  DeliveredMessage,
  ToolDefinition,
} from "@flue/runtime";
import { defineAgentConfig, generateSlackManifest } from "@agentic-slack/core";
import type { SlackChannelAdmissionStore } from "@agentic-slack/core";
import * as v from "valibot";
import { createSlackReadTools } from "../../../packages/core/src/read.ts";
import type { SlackReadBinding } from "../../../packages/core/src/read.ts";
import type { MockedWorkerEnv } from "./module-mocks.ts";
import { mockCloudflareWorkers } from "./module-mocks.ts";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface FakeSlackMessage {
  blocks?: { title?: string; type: string }[];
  bot_id?: string;
  latest_reply?: string;
  text?: string;
  ts: string;
  user?: string;
  username?: string;
}

interface FakeSlackFixture {
  readonly admitted: readonly string[];
  readonly channels: Record<string, FakeSlackMessage[]>;
  readonly pageSize: number;
  readonly threads: Record<string, FakeSlackMessage[]>;
  readonly users: Record<string, string>;
}

interface FakeSlackCall {
  readonly method: string;
  readonly params: URLSearchParams;
}

interface FakeSlackApi {
  readonly calls: FakeSlackCall[];
  readonly fetcher: Fetcher;
}

const NOW_MILLIS = 1_800_000_000_000;
const NOW_TS = "1800000000.000000";

const at = (offset: number, micro = 100): string =>
  `${1_800_000_000 + offset}.${String(micro).padStart(6, "0")}`;

const withinRange = (
  message: FakeSlackMessage,
  params: URLSearchParams,
): boolean => {
  const oldest = params.get("oldest");
  const latest = params.get("latest");
  const ts = Number(message.ts);
  return (
    (oldest === null || ts >= Number(oldest)) &&
    (latest === null || ts <= Number(latest))
  );
};

const slackPage = (
  messages: readonly FakeSlackMessage[],
  params: URLSearchParams,
  pageSize: number,
) => {
  const offset = Number(params.get("cursor") ?? "0");
  const more = offset + pageSize < messages.length;
  return {
    has_more: more,
    messages: messages.slice(offset, offset + pageSize),
    ok: true,
    response_metadata: more ? { next_cursor: String(offset + pageSize) } : {},
  };
};

const respond = (
  method: string,
  params: URLSearchParams,
  fixture: FakeSlackFixture,
) => {
  if (method === "auth.test") {
    return { ok: true, url: "https://workspace.slack.com/" };
  }
  if (method === "users.info") {
    const userId = params.get("user") ?? "";
    return {
      ok: true,
      user: {
        name: userId,
        profile: { display_name: fixture.users[userId] ?? "" },
      },
    };
  }
  if (method === "conversations.history") {
    const channel = params.get("channel") ?? "";
    const messages = (fixture.channels[channel] ?? [])
      .filter((message) => withinRange(message, params))
      .toSorted((left, right) => Number(right.ts) - Number(left.ts));
    return slackPage(messages, params, fixture.pageSize);
  }
  if (method === "conversations.replies") {
    const key = `${params.get("channel") ?? ""}:${params.get("ts") ?? ""}`;
    const messages = (fixture.threads[key] ?? []).filter((message) =>
      withinRange(message, params),
    );
    return slackPage(messages, params, fixture.pageSize);
  }
  return { error: "unknown_method", ok: false };
};

const fakeSlack = (fixture: FakeSlackFixture): FakeSlackApi => {
  const calls: FakeSlackCall[] = [];
  const fetcher: Fetcher = (input, init) => {
    const url = v.parse(v.string(), input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const params = new URLSearchParams(
      v.parse(v.instance(URLSearchParams), init?.body),
    );
    calls.push({ method, params });
    return Promise.resolve(Response.json(respond(method, params, fixture)));
  };
  return { calls, fetcher };
};

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

const failureOf = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const silentLog = { error: () => {}, info: () => {}, warn: () => {} };

interface ReadHarness {
  readonly calls: FakeSlackCall[];
  readonly channelTool: ReturnType<typeof createSlackReadTools>[1];
  readonly cursors: { channelId: string; cursor: string }[];
  readonly threadTool: ReturnType<typeof createSlackReadTools>[0];
}

interface ReadHarnessFixture {
  readonly binding: SlackReadBinding;
  readonly fixture: FakeSlackFixture;
  readonly lookbackSeconds: number;
  readonly maxMessages: number;
  readonly watermark?: string;
}

const admittedStore = (...channels: string[]): SlackChannelAdmissionStore => {
  const admitted = new Set(channels);
  return {
    admit: (channelId) => {
      admitted.add(channelId);
      return Promise.resolve();
    },
    admittedBy: (channelId) =>
      Promise.resolve(admitted.has(channelId) ? "U1" : undefined),
    drop: (channelId) => {
      admitted.delete(channelId);
      return Promise.resolve();
    },
    isAdmitted: (channelId) => Promise.resolve(admitted.has(channelId)),
    listAdmittedChannelIds: () => Promise.resolve([...admitted]),
  };
};

const readHarness = (options: ReadHarnessFixture): ReadHarness => {
  const api = fakeSlack(options.fixture);
  const cursors: { channelId: string; cursor: string }[] = [];
  const state = { cursor: options.watermark };
  const [threadTool, channelTool] = createSlackReadTools(options.binding, {
    admissionStore: admittedStore(...options.fixture.admitted),
    cursorStore: {
      load: () => Promise.resolve(state.cursor),
      save: (channelId, cursor) => {
        cursors.push({ channelId, cursor });
        state.cursor = cursor;
        return Promise.resolve();
      },
    },
    fetcher: api.fetcher,
    lookbackSeconds: options.lookbackSeconds,
    maxMessages: options.maxMessages,
    token: "xoxb-test-token",
  });
  return { calls: api.calls, channelTool, cursors, threadTool };
};

const channelBinding = (
  channelId: string,
  threadTs: string,
): SlackReadBinding => ({
  channelId,
  readsMemberChannels: false,
  surface: "channel",
  threadTs,
});

const withFixedClock = async <TResult>(
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const clock = spyOn(Date, "now").mockReturnValue(NOW_MILLIS);
  try {
    return await run();
  } finally {
    clock.mockRestore();
  }
};

const threadMessages = (
  parentTs: string,
  count: number,
): FakeSlackMessage[] => [
  { text: "root", ts: parentTs, user: "U111" },
  ...Array.from({ length: count - 1 }, (_, index) => ({
    text: `reply ${index + 1}`,
    ts: at(0, 200 + index * 100),
    user: index === 0 ? "U111" : "U222",
  })),
];

test("returns every message of a thread that spans two pages", async () => {
  const parentTs = at(-300);
  const messages = threadMessages(parentTs, 21);
  const harness = readHarness({
    binding: channelBinding("C1", parentTs),
    fixture: {
      admitted: ["C1"],
      channels: {},
      pageSize: 20,
      threads: { [`C1:${parentTs}`]: messages },
      users: { U111: "Ada", U222: "Grace" },
    },
    lookbackSeconds: 3600,
    maxMessages: 100,
  });

  const { output } = await harness.threadTool.run({
    data: {},
    log: silentLog,
    toolCallId: "read-call",
  });

  expect(output.messages.map((message) => message.ts)).toEqual(
    messages.map((message) => message.ts),
  );
  expect(output.coverage).toEqual({
    latest: at(0, 2100),
    lookback: 0,
    nextCursor: null,
    oldest: parentTs,
    parentsExpanded: 0,
    truncated: false,
  });
  expect(
    harness.calls.filter((call) => call.method === "conversations.replies"),
  ).toHaveLength(2);
  expect(output.messages[0]).toEqual({
    author: "Ada",
    permalink: `https://workspace.slack.com/archives/C1/p${parentTs.replace(".", "")}`,
    text: "root",
    ts: parentTs,
  });
  expect(output.messages[1]?.permalink).toBe(
    `https://workspace.slack.com/archives/C1/p${at(0, 200).replace(".", "")}?thread_ts=${parentTs}&cid=C1`,
  );
  expect(
    harness.calls.filter((call) => call.method === "users.info"),
  ).toHaveLength(2);
});

test("reads a streamed reply without the tool step titles Slack puts before its text", async () => {
  const parentTs = at(-300);
  const harness = readHarness({
    binding: channelBinding("C1", parentTs),
    fixture: {
      admitted: ["C1"],
      channels: {},
      pageSize: 50,
      threads: {
        [`C1:${parentTs}`]: [
          { text: "root", ts: parentTs, user: "U111" },
          {
            blocks: [
              { title: "read_thread", type: "task_card" },
              { title: "read_channel_since", type: "task_card" },
              { type: "rich_text" },
            ],
            bot_id: "B1",
            text: "read_thread read_channel_since Carlos opened the PR.",
            ts: at(0, 200),
            user: "UBOT",
          },
          {
            blocks: [{ type: "rich_text" }],
            text: "read_thread is the tool name",
            ts: at(0, 300),
            user: "U111",
          },
        ],
      },
      users: { U111: "Ada", UBOT: "Bloop" },
    },
    lookbackSeconds: 3600,
    maxMessages: 50,
  });

  const thread = await harness.threadTool.run({
    data: {},
    log: silentLog,
    toolCallId: "read-call",
  });

  expect(thread.output.messages.map((message) => message.text)).toEqual([
    "root",
    "Carlos opened the PR.",
    "read_thread is the tool name",
  ]);
});

test("bounds a thread read across a page boundary and resumes it to the end", async () => {
  const parentTs = at(-300);
  const messages = threadMessages(parentTs, 21);
  const harness = readHarness({
    binding: channelBinding("C1", parentTs),
    fixture: {
      admitted: ["C1"],
      channels: {},
      pageSize: 20,
      threads: { [`C1:${parentTs}`]: messages },
      users: { U111: "Ada", U222: "Grace" },
    },
    lookbackSeconds: 3600,
    maxMessages: 20,
  });
  const allTs = messages.map((message) => message.ts);

  const first = await harness.threadTool.run({
    data: {},
    log: silentLog,
    toolCallId: "read-call",
  });
  expect(first.output.messages.map((message) => message.ts)).toEqual(
    allTs.slice(0, 20),
  );
  expect(first.output.coverage.truncated).toBe(true);
  expect(first.output.coverage.nextCursor).toBe(allTs[19] ?? null);

  const second = await harness.threadTool.run({
    data: { oldest: first.output.coverage.nextCursor ?? undefined },
    log: silentLog,
    toolCallId: "read-call",
  });
  expect(second.output.messages.map((message) => message.ts)).toEqual(
    allTs.slice(20),
  );
  expect(second.output.coverage.truncated).toBe(false);
  expect(second.output.coverage.nextCursor).toBeNull();
});

test("expands a parent older than the cursor when its reply is not", async () => {
  const parentTs = at(-800);
  const replyTs = at(-300);
  const harness = readHarness({
    binding: channelBinding("C1", parentTs),
    fixture: {
      admitted: ["C1"],
      channels: {
        C1: [
          { latest_reply: replyTs, text: "parent", ts: parentTs },
          { text: "later top-level", ts: at(-100) },
        ],
      },
      pageSize: 50,
      threads: {
        [`C1:${parentTs}`]: [
          { text: "parent", ts: parentTs },
          { text: "late reply", ts: replyTs, user: "U222" },
        ],
      },
      users: { U222: "Grace" },
    },
    lookbackSeconds: 600,
    maxMessages: 100,
  });

  await withFixedClock(async () => {
    const { output } = await harness.channelTool.run({
      data: { oldest: at(-400, 0) },
      log: silentLog,
      toolCallId: "read-call",
    });

    expect(output.messages.map((message) => message.ts)).toEqual([
      replyTs,
      at(-100),
    ]);
    expect(output.coverage.parentsExpanded).toBe(1);
    expect(output.coverage.oldest).toBe(at(-1000, 0));
  });
});

test("reports a reply older than the lookback in coverage instead of dropping it silently", async () => {
  const parentTs = at(-2000);
  const harness = readHarness({
    binding: channelBinding("C1", parentTs),
    fixture: {
      admitted: ["C1"],
      channels: {
        C1: [{ latest_reply: at(-300), text: "old parent", ts: parentTs }],
      },
      pageSize: 50,
      threads: {
        [`C1:${parentTs}`]: [
          { text: "old parent", ts: parentTs },
          { text: "late reply", ts: at(-300), user: "U222" },
        ],
      },
      users: { U222: "Grace" },
    },
    lookbackSeconds: 600,
    maxMessages: 100,
  });

  await withFixedClock(async () => {
    const { output } = await harness.channelTool.run({
      data: { oldest: at(-400, 0) },
      log: silentLog,
      toolCallId: "read-call",
    });

    expect(output.messages).toEqual([]);
    expect(output.coverage).toEqual({
      latest: NOW_TS,
      lookback: 600,
      nextCursor: null,
      oldest: at(-1000, 0),
      parentsExpanded: 0,
      truncated: false,
    });
  });
});

test("bounds a read, resumes it, and moves the watermark only as far as it covered", async () => {
  const offsets = [-500, -400, -300, -200, -100];
  const harness = readHarness({
    binding: channelBinding("C1", at(-100)),
    fixture: {
      admitted: ["C1"],
      channels: {
        C1: offsets.map((offset) => ({
          text: `message ${offset}`,
          ts: at(offset),
          user: "U111",
        })),
      },
      pageSize: 50,
      threads: {},
      users: { U111: "Ada" },
    },
    lookbackSeconds: 3600,
    maxMessages: 3,
  });

  await withFixedClock(async () => {
    const first = await harness.channelTool.run({
      data: {},
      log: silentLog,
      toolCallId: "read-call",
    });
    expect(first.output.messages.map((message) => message.ts)).toEqual([
      at(-500),
      at(-400),
      at(-300),
    ]);
    expect(first.output.coverage.truncated).toBe(true);
    expect(first.output.coverage.nextCursor).toBe(at(-300));
    expect(harness.cursors).toEqual([{ channelId: "C1", cursor: at(-300) }]);

    const second = await harness.channelTool.run({
      data: {},
      log: silentLog,
      toolCallId: "read-call",
    });
    expect(second.output.messages.map((message) => message.ts)).toEqual([
      at(-200),
      at(-100),
    ]);
    expect(second.output.coverage.truncated).toBe(false);
    expect(second.output.coverage.nextCursor).toBeNull();
    expect(harness.cursors).toEqual([
      { channelId: "C1", cursor: at(-300) },
      { channelId: "C1", cursor: NOW_TS },
    ]);
  });
});

test("leaves the watermark alone when an explicit oldest skips ahead of it", async () => {
  const harness = readHarness({
    binding: channelBinding("C1", at(-100)),
    fixture: {
      admitted: ["C1"],
      channels: { C1: [{ text: "message", ts: at(-50), user: "U111" }] },
      pageSize: 50,
      threads: {},
      users: { U111: "Ada" },
    },
    lookbackSeconds: 3600,
    maxMessages: 100,
    watermark: at(-1000, 0),
  });

  await withFixedClock(async () => {
    const { output } = await harness.channelTool.run({
      data: { oldest: at(-100, 0) },
      log: silentLog,
      toolCallId: "read-call",
    });

    expect(output.messages.map((message) => message.ts)).toEqual([at(-50)]);
    expect(harness.cursors).toEqual([]);
  });
});

test("refuses to read another channel from a channel conversation", async () => {
  const harness = readHarness({
    binding: channelBinding("C1", at(-100)),
    fixture: {
      admitted: ["C1"],
      channels: { C2: [{ text: "elsewhere", ts: at(-50) }] },
      pageSize: 50,
      threads: {},
      users: {},
    },
    lookbackSeconds: 3600,
    maxMessages: 100,
  });

  expect(
    await failureOf(
      Promise.resolve(
        harness.channelTool.run({
          data: { channel: "C2" },
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("read_channel_since can only read this conversation's channel");
  expect(
    await failureOf(
      Promise.resolve(
        harness.threadTool.run({
          data: { channel: "C2" },
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("read_thread can only read this conversation's channel");
  expect(harness.calls).toEqual([]);
});

test("reads a channel the bot joined only from a direct message", async () => {
  const parentTs = at(-800);
  const harness = readHarness({
    binding: {
      channelId: "D777",
      readsMemberChannels: true,
      surface: "private",
      threadTs: at(-100),
    },
    fixture: {
      admitted: ["CJOINED"],
      channels: { CJOINED: [{ text: "hello", ts: at(-50), user: "U111" }] },
      pageSize: 50,
      threads: {
        [`CJOINED:${parentTs}`]: [{ text: "root", ts: parentTs, user: "U111" }],
      },
      users: { U111: "Ada" },
    },
    lookbackSeconds: 3600,
    maxMessages: 100,
  });

  await withFixedClock(async () => {
    const channel = await harness.channelTool.run({
      data: { channel: "CJOINED" },
      log: silentLog,
      toolCallId: "read-call",
    });
    expect(channel.output.messages.map((message) => message.ts)).toEqual([
      at(-50),
    ]);
    expect(
      harness.calls
        .find((call) => call.method === "conversations.history")
        ?.params.get("channel"),
    ).toBe("CJOINED");

    const thread = await harness.threadTool.run({
      data: { channel: "CJOINED", threadTs: parentTs },
      log: silentLog,
      toolCallId: "read-call",
    });
    expect(thread.output.messages.map((message) => message.ts)).toEqual([
      parentTs,
    ]);
  });
});

test("refuses a direct-message read without a channel or without admission", async () => {
  const harness = readHarness({
    binding: {
      channelId: "D777",
      readsMemberChannels: true,
      surface: "private",
      threadTs: at(-100),
    },
    fixture: {
      admitted: [],
      channels: { CFOREIGN: [{ text: "elsewhere", ts: at(-50) }] },
      pageSize: 50,
      threads: {},
      users: {},
    },
    lookbackSeconds: 3600,
    maxMessages: 100,
  });

  expect(
    await failureOf(
      Promise.resolve(
        harness.channelTool.run({
          data: {},
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("read_channel_since in a direct message requires the channel to read");
  expect(
    await failureOf(
      Promise.resolve(
        harness.channelTool.run({
          data: { channel: "CFOREIGN" },
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("no allowed user invited the bot to CFOREIGN, so it cannot read it");
  expect(
    await failureOf(
      Promise.resolve(
        harness.threadTool.run({
          data: { channel: "CFOREIGN" },
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("no allowed user invited the bot to CFOREIGN, so it cannot read it");
  expect(
    harness.calls.filter((call) => call.method === "conversations.history"),
  ).toEqual([]);
});

test("refuses the delivered channel from a mention when no allowed user admitted it", async () => {
  const harness = readHarness({
    binding: channelBinding("C1", at(-100)),
    fixture: {
      admitted: [],
      channels: { C1: [{ text: "private plans", ts: at(-50), user: "U111" }] },
      pageSize: 50,
      threads: {},
      users: {},
    },
    lookbackSeconds: 3600,
    maxMessages: 100,
  });

  expect(
    await failureOf(
      Promise.resolve(
        harness.channelTool.run({
          data: {},
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("no allowed user invited the bot to C1, so it cannot read it");
  expect(
    await failureOf(
      Promise.resolve(
        harness.threadTool.run({
          data: {},
          log: silentLog,
          toolCallId: "read-call",
        }),
      ),
    ),
  ).toBe("no allowed user invited the bot to C1, so it cannot read it");
  expect(harness.calls).toEqual([]);
});

test("calls an injected fetcher with no receiver on both read tools", async () => {
  const parentTs = at(-300);
  const api = fakeSlack({
    admitted: ["C1"],
    channels: { C1: [{ text: "hello", ts: at(-50), user: "U111" }] },
    pageSize: 50,
    threads: { [`C1:${parentTs}`]: threadMessages(parentTs, 2) },
    users: { U111: "Ada" },
  });
  const cursors = new Map<string, string>();
  const [threadTool, channelTool] = createSlackReadTools(
    channelBinding("C1", parentTs),
    {
      admissionStore: admittedStore("C1"),
      cursorStore: {
        load: (channelId) => Promise.resolve(cursors.get(channelId)),
        save: (channelId, cursor) => {
          cursors.set(channelId, cursor);
          return Promise.resolve();
        },
      },
      fetcher: strictFetch(api.fetcher),
      lookbackSeconds: 3600,
      maxMessages: 50,
      token: "xoxb-test-token",
    },
  );

  const thread = await threadTool.run({
    data: {},
    log: silentLog,
    toolCallId: "read-call",
  });
  expect(thread.output.messages.map((message) => message.ts)).toEqual([
    parentTs,
    at(0, 200),
  ]);

  await withFixedClock(async () => {
    const channel = await channelTool.run({
      data: {},
      log: silentLog,
      toolCallId: "read-call",
    });
    expect(channel.output.messages.map((message) => message.ts)).toEqual([
      at(-50),
    ]);
    expect(cursors.get("C1")).toBe(NOW_TS);
  });
});

const readConfig = defineAgentConfig({
  allowedUserIds: ["U111", "U222"],
  description: "Reads Slack conversations.",
  name: "Reader Agent",
  ownerInstructions: "Prefer short answers.",
  read: { lookbackSeconds: 3600, maxMessages: 50 },
});

const neutralConfig = defineAgentConfig({
  description: "Reads nothing.",
  name: "Neutral Reader",
  ownerInstructions: "Prefer short answers.",
});

const manifestScopes = (config: typeof readConfig): string[] =>
  v.parse(
    v.object({
      oauth_config: v.object({
        scopes: v.object({ bot: v.array(v.string()) }),
      }),
    }),
    JSON.parse(generateSlackManifest(config, "https://agent.example.com")),
  ).oauth_config.scopes.bot;

const manifestEvents = (config: typeof readConfig): string[] =>
  v.parse(
    v.object({
      settings: v.object({
        event_subscriptions: v.object({ bot_events: v.array(v.string()) }),
      }),
    }),
    JSON.parse(generateSlackManifest(config, "https://agent.example.com")),
  ).settings.event_subscriptions.bot_events;

test("resolves the read option with defaults and rejects invalid bounds", () => {
  expect(neutralConfig.read).toBeUndefined();
  expect(
    defineAgentConfig({
      description: "Reads with defaults.",
      name: "Default Reader",
      ownerInstructions: "Prefer short answers.",
      read: {},
    }).read,
  ).toEqual({ lookbackSeconds: 86_400, maxMessages: 200 });
  expect(() =>
    defineAgentConfig({
      description: "Bad lookback.",
      name: "Bad Reader",
      ownerInstructions: "Prefer short answers.",
      read: { lookbackSeconds: 0 },
    }),
  ).toThrow("Agent config requires positive integer read.lookbackSeconds");
  expect(() =>
    defineAgentConfig({
      description: "Bad bound.",
      name: "Bad Reader",
      ownerInstructions: "Prefer short answers.",
      read: { maxMessages: 1.5 },
    }),
  ).toThrow("Agent config requires positive integer read.maxMessages");
});

test("adds the read scopes only when the option is set", () => {
  expect(manifestScopes(neutralConfig)).toEqual([
    "app_mentions:read",
    "assistant:write",
    "channels:manage",
    "channels:read",
    "chat:write",
    "groups:read",
    "groups:write",
    "im:history",
    "mpim:read",
    "mpim:write",
    "reactions:write",
  ]);
  expect(manifestScopes(readConfig)).toEqual([
    "app_mentions:read",
    "assistant:write",
    "channels:history",
    "channels:manage",
    "channels:read",
    "chat:write",
    "groups:history",
    "groups:read",
    "groups:write",
    "im:history",
    "mpim:history",
    "mpim:read",
    "mpim:write",
    "reactions:write",
    "users:read",
  ]);
});

test("subscribes to the bot's own joins and to nothing else new", () => {
  expect(manifestEvents(neutralConfig)).toEqual([
    "app_mention",
    "assistant_thread_started",
    "member_joined_channel",
    "message.im",
  ]);
});

const workerEnv: MockedWorkerEnv = { SLACK_BOT_TOKEN: "xoxb-test-token" };
await mockCloudflareWorkers(workerEnv);

type AgentStart = (
  context: Pick<AgentStartContext, "append" | "log" | "signal">,
) => void | Promise<void>;

const mounted: ToolDefinition[] = [];
const agentStarts: AgentStart[] = [];
let delivery: DeliveredMessage = { body: "", kind: "user" };
const runtime = await import("@flue/runtime");
await mock.module("@flue/runtime", () => ({
  ...runtime,
  observe: () => () => {},
  useAgentFinish: () => {},
  useAgentStart: (start: AgentStart) => agentStarts.push(start),
  useDelivery: () => delivery,
  useInstruction: () => {},
  useMcpConnection: () => {},
  useModel: () => {},
  useSkill: () => {},
  useTool: (tool: ToolDefinition) => mounted.push(tool),
}));
const cloudflare = await import("@flue/runtime/cloudflare");
await mock.module("@flue/runtime/cloudflare", () => ({
  ...cloudflare,
  extend: () => ({ base: undefined }),
  getCloudflareContext: () => ({
    storage: { sql: { exec: () => ({ toArray: () => [] }) } },
  }),
}));

const readBindings = v.array(v.union([v.number(), v.string()]));

const fakeReadDb = () => {
  const admissions = new Set<string>();
  const rows = new Map<string, string>();
  return {
    admissions,
    db: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          const bindings = v.parse(readBindings, values);
          const key = String(bindings[0]);
          return {
            all: () => {
              const results: { channel_id?: string; cursor_ts?: string }[] = [];
              if (
                sql.includes("slack_channel_admissions") &&
                admissions.has(key)
              ) {
                results.push({ channel_id: key });
              }
              if (sql.includes("slack_read_cursors") && rows.has(key)) {
                results.push({ cursor_ts: String(rows.get(key)) });
              }
              return Promise.resolve({ results });
            },
            run: () => {
              rows.set(key, String(bindings[1]));
              return Promise.resolve({ meta: { changes: 1 } });
            },
          };
        },
      }),
    },
    rows,
  };
};

const directMessage: DeliveredMessage = {
  attributes: {
    channelId: "D777",
    recipientTeamId: "T123",
    recipientUserId: "U111",
    surface: "private",
    threadTs: at(-100),
  },
  body: "what did I miss",
  kind: "signal",
  type: "slack.message.im",
};

const channelMention: DeliveredMessage = {
  attributes: {
    channelId: "C1",
    recipientTeamId: "T123",
    recipientUserId: "U111",
    surface: "channel",
    threadTs: at(-300),
  },
  body: "hello",
  kind: "signal",
  type: "slack.app_mention",
};

test("mounts no read tool while the option is unset", async () => {
  const { default: shipped } = await import("../agent.config.ts");
  await mock.module("../agent.config.ts", () => ({ default: neutralConfig }));
  try {
    const specifier = "../src/agent.ts?read-unset";
    const entry: unknown = await import(specifier);
    const slackAgent = v.parse(
      v.object({ SlackAgent: v.function() }),
      entry,
    ).SlackAgent;
    mounted.length = 0;
    delivery = channelMention;
    slackAgent({ id: "test" });
    expect(mounted).toEqual([]);
    expect(manifestScopes(neutralConfig)).not.toContain("channels:history");
  } finally {
    await mock.module("../agent.config.ts", () => ({ default: shipped }));
  }
});

test("mounts the read tools bound to the channel of the delivered message", async () => {
  const { default: shipped } = await import("../agent.config.ts");
  const fixture: FakeSlackFixture = {
    admitted: ["C1"],
    channels: { C1: [{ text: "hello", ts: at(-50), user: "U111" }] },
    pageSize: 50,
    threads: {},
    users: { U111: "Ada" },
  };
  const api = fakeSlack(fixture);
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        api.fetcher(input, init),
      { preconnect: fetch.preconnect },
    ),
  );
  const db = fakeReadDb();
  db.admissions.add("C1");
  workerEnv.DB = db.db;
  await mock.module("../agent.config.ts", () => ({ default: readConfig }));
  try {
    const specifier = "../src/agent.ts?read-set";
    const entry: unknown = await import(specifier);
    const slackAgent = v.parse(
      v.object({ SlackAgent: v.function() }),
      entry,
    ).SlackAgent;
    mounted.length = 0;
    delivery = channelMention;
    slackAgent({ id: "test" });

    expect(mounted.map((tool) => tool.name)).toEqual([
      "read_thread",
      "read_channel_since",
    ]);

    const readChannelSince = mounted.find(
      (tool) => tool.name === "read_channel_since",
    );
    if (readChannelSince === undefined) {
      throw new Error("read_channel_since was not mounted");
    }
    await withFixedClock(async () => {
      await readChannelSince.run({
        data: {},
        log: silentLog,
        toolCallId: "read-call",
      });
    });

    expect(
      api.calls
        .find((call) => call.method === "conversations.history")
        ?.params.get("channel"),
    ).toBe("C1");
    expect(db.rows.get("C1")).toBe(NOW_TS);
  } finally {
    network.mockRestore();
    await mock.module("../agent.config.ts", () => ({ default: shipped }));
  }
});

const topLevelAttributes = {
  channelId: "C1",
  message_ts: at(-50),
  recipientTeamId: "T123",
  recipientUserId: "U111",
  surface: "channel",
  threadTs: at(-50),
};

const topLevelMention: DeliveredMessage = {
  attributes: topLevelAttributes,
  body: "what do you think?",
  kind: "signal",
  type: "slack.app_mention",
};

const contextFixture: FakeSlackFixture = {
  admitted: ["C1"],
  channels: {
    C1: [
      { text: "too old to matter", ts: at(-7200), user: "U111" },
      { text: "SQLite or Postgres for the cache?", ts: at(-200), user: "U111" },
      { text: "Postgres, for the runners", ts: at(-100), user: "U222" },
      { text: "what do you think?", ts: at(-50), user: "U111" },
    ],
  },
  pageSize: 50,
  threads: {},
  users: { U111: "Ada", U222: "Grace" },
};

const startAgentWith = async (
  mention: DeliveredMessage,
  admitted: readonly string[],
): Promise<{ appended: AgentAppendMessage[]; calls: FakeSlackCall[] }> => {
  const { default: shipped } = await import("../agent.config.ts");
  const api = fakeSlack(contextFixture);
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(strictFetch(api.fetcher), { preconnect: fetch.preconnect }),
  );
  const db = fakeReadDb();
  for (const channel of admitted) {
    db.admissions.add(channel);
  }
  workerEnv.DB = db.db;
  await mock.module("../agent.config.ts", () => ({ default: readConfig }));
  try {
    const specifier = "../src/agent.ts?read-mention-context";
    const entry: unknown = await import(specifier);
    const slackAgent = v.parse(
      v.object({ SlackAgent: v.function() }),
      entry,
    ).SlackAgent;
    agentStarts.length = 0;
    delivery = mention;
    slackAgent({ id: "test" });
    const appended: AgentAppendMessage[] = [];
    await Promise.all(
      agentStarts.map(async (start) => {
        await start({
          append: (message) => {
            appended.push(message);
          },
          log: silentLog,
          signal: new AbortController().signal,
        });
      }),
    );
    return { appended, calls: api.calls };
  } finally {
    network.mockRestore();
    await mock.module("../agent.config.ts", () => ({ default: shipped }));
  }
};

test("hands the model the channel messages before a mention that opens a thread", async () => {
  const { appended, calls } = await startAgentWith(topLevelMention, ["C1"]);

  const history = calls.find((call) => call.method === "conversations.history");
  expect(history?.params.get("channel")).toBe("C1");
  expect(history?.params.get("latest")).toBe(at(-50));
  expect(history?.params.get("limit")).toBe("50");
  expect(appended).toHaveLength(1);
  const [context] = appended;
  expect(context?.type).toBe("slack.channel_context");
  const body = context?.body ?? "";
  expect(body).toContain("Ada");
  expect(body.indexOf("SQLite or Postgres for the cache?")).toBeGreaterThan(-1);
  expect(body.indexOf("Postgres, for the runners")).toBeGreaterThan(
    body.indexOf("SQLite or Postgres for the cache?"),
  );
  expect(body).not.toContain("too old to matter");
  expect(body).not.toContain("what do you think?");
});

test("leaves a mention inside a thread to read_thread", async () => {
  const { appended, calls } = await startAgentWith(
    {
      ...topLevelMention,
      attributes: { ...topLevelAttributes, threadTs: at(-300) },
    },
    ["C1"],
  );

  expect(appended).toEqual([]);
  expect(calls.map((call) => call.method)).not.toContain(
    "conversations.history",
  );
});

test("tells the model why the channel before a mention could not be read", async () => {
  const { appended, calls } = await startAgentWith(topLevelMention, []);

  expect(calls.map((call) => call.method)).not.toContain(
    "conversations.history",
  );
  expect(appended).toHaveLength(1);
  expect(appended[0]?.body).toContain("no allowed user invited the bot to C1");
});

test("lets the owner's direct message name the channel it reads", async () => {
  const { default: shipped } = await import("../agent.config.ts");
  const fixture: FakeSlackFixture = {
    admitted: ["CJOINED"],
    channels: { CJOINED: [{ text: "hello", ts: at(-50), user: "U111" }] },
    pageSize: 50,
    threads: {},
    users: { U111: "Ada" },
  };
  const api = fakeSlack(fixture);
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        api.fetcher(input, init),
      { preconnect: fetch.preconnect },
    ),
  );
  const db = fakeReadDb();
  db.admissions.add("CJOINED");
  workerEnv.DB = db.db;
  await mock.module("../agent.config.ts", () => ({ default: readConfig }));
  try {
    const specifier = "../src/agent.ts?read-dm";
    const entry: unknown = await import(specifier);
    const slackAgent = v.parse(
      v.object({ SlackAgent: v.function() }),
      entry,
    ).SlackAgent;
    mounted.length = 0;
    delivery = directMessage;
    slackAgent({ id: "test" });

    const readChannelSince = mounted.find(
      (tool) => tool.name === "read_channel_since",
    );
    if (readChannelSince === undefined) {
      throw new Error("read_channel_since was not mounted");
    }
    await withFixedClock(async () => {
      await readChannelSince.run({
        data: { channel: "CJOINED" },
        log: silentLog,
        toolCallId: "read-call",
      });
    });

    expect(
      api.calls
        .find((call) => call.method === "conversations.history")
        ?.params.get("channel"),
    ).toBe("CJOINED");
    expect(db.rows.get("CJOINED")).toBe(NOW_TS);
  } finally {
    network.mockRestore();
    await mock.module("../agent.config.ts", () => ({ default: shipped }));
  }
});

test("reads through the tools agent.ts mounts when the global fetch rejects a receiver", async () => {
  const { default: shipped } = await import("../agent.config.ts");
  const parentTs = at(-300);
  const api = fakeSlack({
    admitted: ["C1"],
    channels: { C1: [{ text: "hello", ts: at(-50), user: "U111" }] },
    pageSize: 50,
    threads: { [`C1:${parentTs}`]: threadMessages(parentTs, 2) },
    users: { U111: "Ada" },
  });
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(strictFetch(api.fetcher), { preconnect: fetch.preconnect }),
  );
  const db = fakeReadDb();
  db.admissions.add("C1");
  workerEnv.DB = db.db;
  await mock.module("../agent.config.ts", () => ({ default: readConfig }));
  try {
    const specifier = "../src/agent.ts?read-strict-fetch";
    const entry: unknown = await import(specifier);
    const slackAgent = v.parse(
      v.object({ SlackAgent: v.function() }),
      entry,
    ).SlackAgent;
    mounted.length = 0;
    delivery = channelMention;
    slackAgent({ id: "test" });

    const readThread = mounted.find((tool) => tool.name === "read_thread");
    const readChannelSince = mounted.find(
      (tool) => tool.name === "read_channel_since",
    );
    if (readThread === undefined || readChannelSince === undefined) {
      throw new Error("the read tools were not mounted");
    }

    await readThread.run({
      data: {},
      log: silentLog,
      toolCallId: "read-call",
    });
    await withFixedClock(async () => {
      await readChannelSince.run({
        data: {},
        log: silentLog,
        toolCallId: "read-call",
      });
    });

    expect(
      api.calls
        .filter((call) => call.method === "conversations.replies")
        .map((call) => call.params.get("ts")),
    ).toEqual([parentTs]);
    expect(
      api.calls
        .filter((call) => call.method === "conversations.history")
        .map((call) => call.params.get("channel")),
    ).toEqual(["C1"]);
    expect(db.rows.get("C1")).toBe(NOW_TS);
  } finally {
    network.mockRestore();
    await mock.module("../agent.config.ts", () => ({ default: shipped }));
  }
});

test("binds a direct message from a user who is not an owner to its own conversation", async () => {
  const { default: shipped } = await import("../agent.config.ts");
  const fixture: FakeSlackFixture = {
    admitted: ["CJOINED"],
    channels: {
      CJOINED: [{ text: "private plans", ts: at(-50), user: "U111" }],
      D888: [{ text: "hi", ts: at(-40), user: "U333" }],
    },
    pageSize: 50,
    threads: {},
    users: { U333: "Grace" },
  };
  const api = fakeSlack(fixture);
  const network = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        api.fetcher(input, init),
      { preconnect: fetch.preconnect },
    ),
  );
  const db = fakeReadDb();
  workerEnv.DB = db.db;
  const unlisted = defineAgentConfig({
    description: "Reads Slack conversations.",
    name: "Reader Agent",
    ownerInstructions: "Prefer short answers.",
    read: { lookbackSeconds: 3600, maxMessages: 50 },
  });
  const configs = [
    { config: readConfig, specifier: "../src/agent.ts?read-dm-guest" },
    { config: unlisted, specifier: "../src/agent.ts?read-dm-unlisted" },
  ];
  try {
    for (const { config, specifier } of configs) {
      // oxlint-disable-next-line no-await-in-loop
      await mock.module("../agent.config.ts", () => ({ default: config }));
      // oxlint-disable-next-line no-await-in-loop
      const entry: unknown = await import(specifier);
      const slackAgent = v.parse(
        v.object({ SlackAgent: v.function() }),
        entry,
      ).SlackAgent;
      mounted.length = 0;
      delivery = {
        ...directMessage,
        attributes: {
          ...directMessage.attributes,
          channelId: "D888",
          recipientUserId: "U333",
        },
      };
      slackAgent({ id: "test" });

      const readChannelSince = mounted.find(
        (tool) => tool.name === "read_channel_since",
      );
      if (readChannelSince === undefined) {
        throw new Error("read_channel_since was not mounted");
      }
      expect(
        // oxlint-disable-next-line no-await-in-loop
        await failureOf(
          Promise.resolve(
            readChannelSince.run({
              data: { channel: "CJOINED" },
              log: silentLog,
              toolCallId: "read-call",
            }),
          ),
        ),
      ).toBe("read_channel_since can only read this conversation's channel");
      // oxlint-disable-next-line no-await-in-loop
      await withFixedClock(async () => {
        await readChannelSince.run({
          data: {},
          log: silentLog,
          toolCallId: "read-call",
        });
      });
    }
    expect(
      api.calls
        .filter((call) => call.method === "conversations.history")
        .map((call) => call.params.get("channel")),
    ).toEqual(["D888", "D888"]);
  } finally {
    network.mockRestore();
    await mock.module("../agent.config.ts", () => ({ default: shipped }));
  }
});
