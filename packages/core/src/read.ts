import { defineTool } from "@flue/runtime";
import type { ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import type { SlackChannelAdmissionStore } from "./admission.ts";
import type { ConversationSurface } from "./retention.ts";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const SLACK_API = "https://slack.com/api/";
// Slack caps conversations.replies at 1000 and documents 200 as the page size
// its own pagination is tuned for; history's default is 100.
const PAGE_LIMIT = 200;
const NO_MESSAGES_BEFORE = Number.NEGATIVE_INFINITY;

export interface SlackReadCursorStore {
  readonly load: (channelId: string) => Promise<string | undefined>;
  readonly save: (
    channelId: string,
    cursor: string,
    now: number,
  ) => Promise<void>;
}

const cursorRow = v.object({ cursor_ts: v.string() });

export const createSqlSlackReadCursorStore = (
  db: D1Database,
): SlackReadCursorStore => ({
  async load(channelId) {
    const { results } = await db
      .prepare("SELECT cursor_ts FROM slack_read_cursors WHERE channel_id = ?1")
      .bind(channelId)
      .all();
    const [row] = results;
    return v.is(cursorRow, row) ? row.cursor_ts : undefined;
  },
  async save(channelId, cursor, now) {
    await db
      .prepare(
        `INSERT INTO slack_read_cursors (channel_id, cursor_ts, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(channel_id) DO UPDATE SET cursor_ts = excluded.cursor_ts, updated_at = excluded.updated_at`,
      )
      .bind(channelId, cursor, now)
      .run();
  },
});

export interface SlackReadBinding {
  readonly channelId: string;
  readonly readsMemberChannels: boolean;
  readonly surface: ConversationSurface;
  readonly threadTs: string;
}

export interface SlackReadOptions {
  readonly admissionStore: SlackChannelAdmissionStore;
  readonly cursorStore: SlackReadCursorStore;
  readonly fetcher?: Fetcher;
  readonly lookbackSeconds: number;
  readonly maxMessages: number;
  readonly token: string;
}

interface SlackCaller {
  readonly fetcher: Fetcher;
  readonly signal?: AbortSignal;
  readonly token: string;
}

const slackEnvelope = {
  error: v.optional(v.string()),
  ok: v.boolean(),
};

interface SlackEnvelope {
  readonly error?: string;
  readonly ok: boolean;
}

const slackMessageSchema = v.object({
  bot_id: v.optional(v.string()),
  latest_reply: v.optional(v.string()),
  text: v.optional(v.string()),
  ts: v.string(),
  user: v.optional(v.string()),
  username: v.optional(v.string()),
});

type SlackMessage = v.InferOutput<typeof slackMessageSchema>;

const slackPageSchema = v.object({
  ...slackEnvelope,
  has_more: v.optional(v.boolean(), false),
  messages: v.optional(v.array(slackMessageSchema), []),
  response_metadata: v.optional(
    v.object({ next_cursor: v.optional(v.string()) }),
  ),
});

const slackUserSchema = v.object({
  name: v.optional(v.string()),
  profile: v.optional(
    v.object({
      display_name: v.optional(v.string()),
      real_name: v.optional(v.string()),
    }),
  ),
  real_name: v.optional(v.string()),
});

const usersInfoSchema = v.object({
  ...slackEnvelope,
  user: v.optional(slackUserSchema),
});

const authTestSchema = v.object({
  ...slackEnvelope,
  url: v.pipe(v.string(), v.nonEmpty()),
});

type SlackParams = Record<string, string | undefined>;

const callSlack = async <TOutput extends SlackEnvelope>(
  caller: SlackCaller,
  method: string,
  params: SlackParams,
  schema: v.GenericSchema<unknown, TOutput>,
): Promise<TOutput> => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      body.set(name, value);
    }
  }
  // A fetcher reached through an object would run with that object as its
  // receiver, which workerd's global fetch rejects as an illegal invocation.
  const { fetcher } = caller;
  const response = await fetcher(`${SLACK_API}${method}`, {
    body,
    headers: {
      authorization: `Bearer ${caller.token}`,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    method: "POST",
    signal: caller.signal,
  });
  const parsed = v.parse(schema, await response.json());
  if (!parsed.ok) {
    throw new Error(
      `Slack ${method} failed: ${parsed.error ?? "unknown_error"}`,
    );
  }
  return parsed;
};

const fullPages = async (
  caller: SlackCaller,
  method: string,
  params: SlackParams,
): Promise<SlackMessage[]> => {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const page = await callSlack(
      caller,
      method,
      {
        ...params,
        cursor,
        limit: String(PAGE_LIMIT),
      },
      slackPageSchema,
    );
    messages.push(...page.messages);
    const next = page.response_metadata?.next_cursor;
    // Slack documents `has_more` and `next_cursor` together, so a page that
    // claims more without naming the cursor would loop forever.
    if (!page.has_more || next === undefined) {
      return messages;
    }
    cursor = next;
  }
};

const tsFromSeconds = (seconds: number): string => seconds.toFixed(6);

const tsFromMillis = (millis: number): string => tsFromSeconds(millis / 1000);

const tsMinus = (ts: string, seconds: number): string =>
  tsFromSeconds(Math.max(0, Number(ts) - seconds));

interface WorkspaceCache {
  url?: string;
}

interface ReadContext {
  readonly caller: SlackCaller;
  readonly users: Map<string, string>;
  readonly workspace: WorkspaceCache;
}

const workspaceUrl = async (ctx: ReadContext): Promise<string> => {
  if (ctx.workspace.url === undefined) {
    const { url } = await callSlack(
      ctx.caller,
      "auth.test",
      {},
      authTestSchema,
    );
    ctx.workspace.url = url.endsWith("/") ? url : `${url}/`;
  }
  return ctx.workspace.url;
};

const usersInfoName = async (
  ctx: ReadContext,
  userId: string,
): Promise<string> => {
  try {
    const { user } = await callSlack(
      ctx.caller,
      "users.info",
      { user: userId },
      usersInfoSchema,
    );
    const name = [
      user?.profile?.display_name,
      user?.real_name,
      user?.profile?.real_name,
      user?.name,
    ].find((candidate) => candidate !== undefined && candidate.trim() !== "");
    return name === undefined ? userId : name.trim();
  } catch (error) {
    // A deleted or external author is not a reason to fail the whole read, but
    // a cancelled call must still stop.
    if (ctx.caller.signal?.aborted === true) {
      throw error;
    }
    return userId;
  }
};

const authorName = async (
  ctx: ReadContext,
  message: SlackMessage,
): Promise<string> => {
  const { user: userId } = message;
  if (userId === undefined || userId === "") {
    return message.username ?? message.bot_id ?? "unknown";
  }
  const cached = ctx.users.get(userId);
  if (cached !== undefined) {
    return cached;
  }
  const name = await usersInfoName(ctx, userId);
  ctx.users.set(userId, name);
  return name;
};

const permalinkFor = (
  workspace: string,
  channelId: string,
  ts: string,
  threadTs: string,
): string => {
  const message = `${workspace}archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs === ts
    ? message
    : `${message}?thread_ts=${threadTs}&cid=${channelId}`;
};

const readCoverageSchema = v.object({
  latest: v.string(),
  lookback: v.number(),
  nextCursor: v.nullable(v.string()),
  oldest: v.string(),
  parentsExpanded: v.number(),
  truncated: v.boolean(),
});

const readMessageSchema = v.object({
  author: v.string(),
  permalink: v.string(),
  text: v.string(),
  ts: v.string(),
});

type SlackReadMessageRecord = v.InferInput<typeof readMessageSchema>;

const readOutputSchema = v.object({
  coverage: readCoverageSchema,
  messages: v.array(readMessageSchema),
});

interface SlackReadRow {
  readonly message: SlackMessage;
  readonly threadTs: string;
}

interface SlackReadPage {
  readonly coverage: v.InferInput<typeof readCoverageSchema>;
  readonly messages: SlackReadMessageRecord[];
}

const messageRecords = async (
  ctx: ReadContext,
  channelId: string,
  rows: readonly SlackReadRow[],
): Promise<SlackReadMessageRecord[]> => {
  if (rows.length === 0) {
    return [];
  }
  const workspace = await workspaceUrl(ctx);
  const records: SlackReadMessageRecord[] = [];
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop
    const author = await authorName(ctx, row.message);
    records.push({
      author,
      permalink: permalinkFor(
        workspace,
        channelId,
        row.message.ts,
        row.threadTs,
      ),
      text: row.message.text ?? "",
      ts: row.message.ts,
    });
  }
  return records;
};

const threadInput = v.object({
  channel: v.optional(v.string()),
  oldest: v.optional(v.string()),
  threadTs: v.optional(v.string()),
});

const channelInput = v.object({
  channel: v.optional(v.string()),
  oldest: v.optional(v.string()),
});

const boundToChannel = (
  binding: SlackReadBinding,
  bound: string,
  unbound: string,
): string => (binding.readsMemberChannels ? unbound : bound);

const requestedChannel = (
  binding: SlackReadBinding,
  requested: string | undefined,
  tool: string,
): string => {
  const channel = requested?.trim() ?? "";
  if (!binding.readsMemberChannels) {
    if (channel !== "" && channel !== binding.channelId) {
      throw new Error(`${tool} can only read this conversation's channel`);
    }
    return binding.channelId;
  }
  if (channel === "") {
    throw new Error(`${tool} in a direct message requires the channel to read`);
  }
  return channel;
};

// The conversation a delivery arrived in is trusted by that delivery; every
// other channel has to have been admitted by an allowlisted inviter.
const readsAdmittedChannel = (
  binding: SlackReadBinding,
  channelId: string,
): boolean => binding.surface === "channel" || channelId !== binding.channelId;

const requireAdmission = async (
  options: SlackReadOptions,
  channelId: string,
): Promise<void> => {
  if (!(await options.admissionStore.isAdmitted(channelId))) {
    throw new Error(
      `no allowed user invited the bot to ${channelId}, so it cannot read it`,
    );
  }
};

const readThread = async (
  binding: SlackReadBinding,
  ctx: ReadContext,
  options: SlackReadOptions,
  data: v.InferOutput<typeof threadInput>,
): Promise<SlackReadPage> => {
  const channelId = requestedChannel(binding, data.channel, "read_thread");
  if (readsAdmittedChannel(binding, channelId)) {
    await requireAdmission(options, channelId);
  }
  const requestedThread = data.threadTs?.trim() ?? "";
  const threadTs =
    requestedThread === ""
      ? boundToChannel(binding, binding.threadTs, "")
      : requestedThread;
  if (threadTs === "") {
    throw new Error(
      "read_thread in a direct message requires the threadTs of the thread's first message",
    );
  }
  const threshold =
    data.oldest === undefined ? NO_MESSAGES_BEFORE : Number(data.oldest);
  const rows: SlackReadRow[] = [];
  let pageCursor: string | undefined;
  let examined = threadTs;
  let truncated = false;
  let hasMore = true;
  while (hasMore) {
    // oxlint-disable-next-line no-await-in-loop
    const page = await callSlack(
      ctx.caller,
      "conversations.replies",
      {
        channel: channelId,
        cursor: pageCursor,
        limit: String(PAGE_LIMIT),
        ts: threadTs,
      },
      slackPageSchema,
    );
    for (const message of page.messages) {
      examined = message.ts;
      if (Number(message.ts) <= threshold) {
        continue;
      }
      if (rows.length === options.maxMessages) {
        truncated = true;
        break;
      }
      rows.push({ message, threadTs });
    }
    const next = page.response_metadata?.next_cursor;
    hasMore = !truncated && page.has_more && next !== undefined;
    pageCursor = next;
  }
  const last = rows.at(-1)?.message.ts ?? threadTs;
  return {
    coverage: {
      latest: truncated ? last : examined,
      lookback: 0,
      nextCursor: truncated ? last : null,
      oldest: threadTs,
      parentsExpanded: 0,
      truncated,
    },
    messages: await messageRecords(ctx, channelId, rows),
  };
};

interface ExpandedParents {
  readonly parentsExpanded: number;
  readonly rows: SlackReadRow[];
}

// history returns top-level messages only, so a thread that gained replies after
// the cursor stays invisible until its parent is expanded.
const expandParents = async (
  ctx: ReadContext,
  channelId: string,
  parents: readonly SlackMessage[],
  threshold: number,
): Promise<ExpandedParents> => {
  const rows: SlackReadRow[] = [];
  let parentsExpanded = 0;
  for (const parent of parents) {
    if (Number(parent.ts) > threshold) {
      rows.push({ message: parent, threadTs: parent.ts });
    }
    const { latest_reply: latestReply } = parent;
    if (latestReply === undefined || Number(latestReply) <= threshold) {
      continue;
    }
    parentsExpanded += 1;
    // oxlint-disable-next-line no-await-in-loop
    const replies = await fullPages(ctx.caller, "conversations.replies", {
      channel: channelId,
      ts: parent.ts,
    });
    for (const reply of replies) {
      if (reply.ts !== parent.ts && Number(reply.ts) > threshold) {
        rows.push({ message: reply, threadTs: parent.ts });
      }
    }
  }
  return { parentsExpanded, rows };
};

const readChannelSince = async (
  binding: SlackReadBinding,
  ctx: ReadContext,
  options: SlackReadOptions,
  data: v.InferOutput<typeof channelInput>,
): Promise<SlackReadPage> => {
  const channelId = requestedChannel(
    binding,
    data.channel,
    "read_channel_since",
  );
  if (readsAdmittedChannel(binding, channelId)) {
    await requireAdmission(options, channelId);
  }
  const stored = await options.cursorStore.load(channelId);
  const cursor = data.oldest ?? stored;
  const latest = tsFromMillis(Date.now());
  const oldest = tsMinus(cursor ?? latest, options.lookbackSeconds);
  const threshold = cursor === undefined ? NO_MESSAGES_BEFORE : Number(cursor);
  const parents = await fullPages(ctx.caller, "conversations.history", {
    channel: channelId,
    latest,
    oldest,
  });
  const { parentsExpanded, rows } = await expandParents(
    ctx,
    channelId,
    parents,
    threshold,
  );
  rows.sort(
    (left, right) => Number(left.message.ts) - Number(right.message.ts),
  );
  const truncated = rows.length > options.maxMessages;
  const kept = truncated ? rows.slice(0, options.maxMessages) : rows;
  const last = kept.at(-1)?.message.ts ?? null;
  // The watermark only ever moves to a point whose coverage is complete: a page
  // cut by the message bound ends at its last returned message, and a read that
  // named an `oldest` newer than the stored watermark would leave everything
  // between the two unread, so it leaves the watermark where it was.
  const skipsAhead =
    stored !== undefined &&
    cursor !== undefined &&
    Number(cursor) > Number(stored);
  if (!skipsAhead) {
    await options.cursorStore.save(
      channelId,
      truncated ? (last ?? latest) : latest,
      Date.now(),
    );
  }
  return {
    coverage: {
      latest,
      lookback: options.lookbackSeconds,
      nextCursor: truncated ? last : null,
      oldest,
      parentsExpanded,
      truncated,
    },
    messages: await messageRecords(ctx, channelId, kept),
  };
};

export interface SlackMention {
  readonly channelId: string;
  readonly ts: string;
}

// A mention that opens a thread arrives with nothing but its own text, and the
// model reaches for read_thread, which holds only that mention; the channel it
// answers has to be in front of the model before its first turn.
export const readChannelBeforeMention = async (
  mention: SlackMention,
  options: SlackReadOptions,
  signal: AbortSignal,
): Promise<string> => {
  const ctx: ReadContext = {
    caller: { fetcher: options.fetcher ?? fetch, signal, token: options.token },
    users: new Map(),
    workspace: {},
  };
  try {
    await requireAdmission(options, mention.channelId);
    const oldest = tsMinus(mention.ts, options.lookbackSeconds);
    const page = await callSlack(
      ctx.caller,
      "conversations.history",
      {
        channel: mention.channelId,
        latest: mention.ts,
        limit: String(options.maxMessages),
        oldest,
      },
      slackPageSchema,
    );
    const rows = page.messages
      .filter((message) => message.ts !== mention.ts)
      .toReversed()
      .map((message) => ({ message, threadTs: message.ts }));
    const messages = await messageRecords(ctx, mention.channelId, rows);
    const coverage = {
      latest: mention.ts,
      oldest: page.has_more ? (messages[0]?.ts ?? oldest) : oldest,
      truncated: page.has_more,
    };
    return `This mention opened a new thread, so read_thread holds only the mention. The channel messages posted before it, oldest first:\n${JSON.stringify({ coverage, messages })}`;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return `Reading the channel before this mention failed: ${error instanceof Error ? error.message : String(error)}`;
  }
};

export const createSlackReadTools = (
  binding: SlackReadBinding,
  options: SlackReadOptions,
): readonly [
  ToolDefinition<typeof threadInput, typeof readOutputSchema, boolean, boolean>,
  ToolDefinition<
    typeof channelInput,
    typeof readOutputSchema,
    boolean,
    boolean
  >,
] => {
  const caller: SlackCaller = {
    fetcher: options.fetcher ?? fetch,
    token: options.token,
  };
  const context = (signal: AbortSignal | undefined): ReadContext => ({
    caller: signal === undefined ? caller : { ...caller, signal },
    users: new Map(),
    workspace: {},
  });
  return [
    defineTool({
      description: boundToChannel(
        binding,
        "Read the whole Slack thread of this conversation, oldest message first, with no arguments needed; `threadTs` names another thread of that same channel. Returns compact records with author, timestamp, permalink and text, plus a coverage block. A `truncated` block names a `nextCursor`: call again with `oldest` set to it to read the rest. Never reads another channel.",
        "Read one Slack thread, oldest message first: pass the `channel` it lives in and the `threadTs` of its first message. Only a channel an allowed user invited the bot to is readable. Returns compact records with author, timestamp, permalink and text, plus a coverage block. A `truncated` block names a `nextCursor`: call again with `oldest` set to it to read the rest.",
      ),
      input: threadInput,
      name: "read_thread",
      output: readOutputSchema,
      async run({ data, signal }) {
        return {
          output: await readThread(binding, context(signal), options, data),
        };
      },
    }),
    defineTool({
      description: boundToChannel(
        binding,
        "Read the messages posted in this conversation's channel after a cursor, oldest first. Without `oldest` it continues from the last complete read of this channel, or from the configured lookback window when there is none. Replies to older parents inside that window are included. Returns compact records with author, timestamp, permalink and text, plus a coverage block whose `oldest` names the earliest point it looked back to. A `truncated` block names a `nextCursor`: call again with `oldest` set to it to read the rest. Never reads another channel.",
        "Read the messages posted in one channel after a cursor, oldest first: pass a `channel` an allowed user invited the bot to. Without `oldest` it continues from the last complete read of that channel, or from the configured lookback window when there is none. Replies to older parents inside that window are included. Returns compact records with author, timestamp, permalink and text, plus a coverage block whose `oldest` names the earliest point it looked back to. A `truncated` block names a `nextCursor`: call again with `oldest` set to it to read the rest.",
      ),
      input: channelInput,
      name: "read_channel_since",
      output: readOutputSchema,
      async run({ data, signal }) {
        return {
          output: await readChannelSince(
            binding,
            context(signal),
            options,
            data,
          ),
        };
      },
    }),
  ];
};

export const readThreadReplies = async (
  options: Pick<SlackReadOptions, "fetcher" | "token">,
  channelId: string,
  threadTs: string,
  oldest: string | undefined,
): Promise<SlackReadMessageRecord[]> => {
  const ctx: ReadContext = {
    caller: { fetcher: options.fetcher ?? fetch, token: options.token },
    users: new Map(),
    workspace: {},
  };
  const after = Math.max(Number(threadTs), Number(oldest ?? threadTs));
  const replies = await fullPages(ctx.caller, "conversations.replies", {
    channel: channelId,
    oldest,
    ts: threadTs,
  });
  return await messageRecords(
    ctx,
    channelId,
    replies
      .filter((message) => Number(message.ts) > after)
      .map((message) => ({ message, threadTs })),
  );
};
