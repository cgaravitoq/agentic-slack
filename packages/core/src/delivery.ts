import type { FlueObservation } from "@flue/runtime";
import * as v from "valibot";
import type { ConversationSurface } from "./retention.ts";
import type { RoutedSlackTurn } from "./slack.ts";
import { clampTaskChunk, SLACK_TASK_FALLBACK_TITLE } from "./task-chunk.ts";
import type { SlackTaskChunk, SlackTaskUpdate } from "./task-chunk.ts";

const BROADCAST_RE = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/giu;
const SUBTEAM_RE = /<!subteam\^[^>]+>/giu;
const CONTROL_OPENER_RE = /<(?=[@#!])/gu;
const SLACK_TOKEN_RE = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+/gu;
const SECRET_ASSIGNMENT_RE =
  /(?:\\["'])?["']?\b[A-Z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|API_KEY|SIGNING_SECRET)[A-Z0-9_]{0,64}(?:\\["'])?["']?\s{0,16}[:=]\s{0,16}(?:\\"[^"\\]{0,200}\\"|\\'[^'\\]{0,200}\\'|"[^"]{0,200}"|'[^']{0,200}'|[^,\s"']{1,200})/giu;
export const STREAM_TAIL_LENGTH = 512;

export const MAX_SLACK_MESSAGE_LENGTH = 3900;
export const MAX_SLACK_APPEND_LENGTH = 12_000;
const TRUNCATION_NOTICE = "\n\n(truncated)";
// A replay can only deliver the prefix Slack still accepts, and the margin
// keeps a redaction match that straddles the visible cut redacting the same way
// it does on the live path (the sanitizer tail already assumes that bound).
const MAX_DURABLE_REPLY_LENGTH = MAX_SLACK_MESSAGE_LENGTH + STREAM_TAIL_LENGTH;

export const SLACK_DELIVERY_FALLBACK =
  "I finished the turn but produced no reply. Please try again.";
export const SLACK_STREAM_FAILURE_NOTICE =
  "I hit an error before finishing that reply. Please try again.";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const slackResult = v.object({
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
  ts: v.optional(v.string()),
});

const redact = (text: string): string =>
  text
    .replace(BROADCAST_RE, "")
    .replace(SUBTEAM_RE, "")
    .replace(CONTROL_OPENER_RE, "&lt;")
    .replace(SLACK_TOKEN_RE, "[secret]")
    .replace(SECRET_ASSIGNMENT_RE, "[internal configuration]")
    .replaceAll(/\n{3,}/gu, "\n\n");

const sanitizeTaskText = (text: string, fallback = ""): string => {
  const safe = redact(text).replaceAll(/\s+/gu, " ").trim();
  return safe === "" ? fallback : safe;
};

const clipUtf16 = (text: string, room: number): string => {
  if (room <= 0) {
    return "";
  }
  const kept = text.slice(0, room);
  return (/[\uD800-\uDBFF]$/u.test(kept) ? kept.slice(0, -1) : kept).trimEnd();
};

export const sanitizeReply = (
  text: string,
  maxLength = MAX_SLACK_MESSAGE_LENGTH,
): string => {
  let safe = redact(text).trim();
  if (!safe) {
    safe = "I could not produce a safe reply for that content.";
  }
  if (safe.length > maxLength) {
    safe = `${clipUtf16(safe, maxLength - 20)}${TRUNCATION_NOTICE}`;
  }
  return safe;
};

export interface StreamSanitizer {
  push: (delta: string) => string;
  flush: () => string;
}

export const createStreamSanitizer = (): StreamSanitizer => {
  let buffer = "";
  let started = false;
  const emit = (raw: string): string => {
    const safe = started ? redact(raw) : redact(raw).trimStart();
    started ||= safe !== "";
    return safe;
  };
  const release = (): string => {
    if (buffer.length <= STREAM_TAIL_LENGTH) {
      return "";
    }
    let cut = buffer.length - STREAM_TAIL_LENGTH;
    if (/[\uDC00-\uDFFF]/u.test(buffer.charAt(cut))) {
      cut -= 1;
    }
    if (cut <= 0) {
      return "";
    }
    const head = buffer.slice(0, cut);
    buffer = buffer.slice(cut);
    return emit(head);
  };
  return {
    flush() {
      const rest = buffer;
      buffer = "";
      return emit(rest).trimEnd();
    },
    push(delta) {
      let emitted = "";
      for (
        let offset = 0;
        offset < delta.length;
        offset += STREAM_TAIL_LENGTH
      ) {
        buffer += delta.slice(offset, offset + STREAM_TAIL_LENGTH);
        emitted += release();
      }
      return emitted;
    },
  };
};

const routedOrigin = Symbol("routedOrigin");

interface SlackStreamTarget {
  readonly channelId: string;
  readonly threadTs: string;
  readonly recipientUserId: string;
  readonly recipientTeamId: string;
  readonly surface: ConversationSurface;
  readonly [routedOrigin]: true;
}

export const streamTargetFor = (turn: RoutedSlackTurn): SlackStreamTarget =>
  Object.freeze<SlackStreamTarget>({
    [routedOrigin]: true,
    channelId: turn.channelId,
    recipientTeamId: turn.teamId,
    recipientUserId: turn.userId,
    surface: turn.surface,
    threadTs: turn.threadTs,
  });

export const slackDeliveryBindingSchema = v.object({
  channelId: v.pipe(v.string(), v.minLength(1)),
  recipientTeamId: v.pipe(v.string(), v.minLength(1)),
  recipientUserId: v.pipe(v.string(), v.minLength(1)),
  surface: v.picklist(["channel", "private"]),
  threadTs: v.pipe(v.string(), v.minLength(1)),
});

export type SlackDeliveryBinding = v.InferOutput<
  typeof slackDeliveryBindingSchema
>;

export const slackDeliveryBinding = (
  target: SlackStreamTarget,
): SlackDeliveryBinding =>
  v.parse(slackDeliveryBindingSchema, {
    channelId: target.channelId,
    recipientTeamId: target.recipientTeamId,
    recipientUserId: target.recipientUserId,
    surface: target.surface,
    threadTs: target.threadTs,
  });

const streamTargetFromBinding = (
  binding: SlackDeliveryBinding,
): SlackStreamTarget =>
  streamTargetFor({
    appId: "_",
    channelId: binding.channelId,
    eventId: "_",
    kind: "turn",
    messageTs: "_",
    surface: binding.surface,
    teamId: binding.recipientTeamId,
    text: "_",
    threadTs: binding.threadTs,
    userId: binding.recipientUserId,
  });

export interface SlackStream {
  append: (delta: string) => void;
  task: (update: SlackTaskUpdate) => void;
  finish: (fallback: string) => Promise<void>;
  fail: (notice: string) => Promise<void>;
}

export type SlackDeliveryEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-result"; id: string; output: string; error: boolean };

interface SlackDeliveryRecord {
  binding: SlackDeliveryBinding;
  events: SlackDeliveryEvent[];
  replyText: string;
  failed: boolean;
  closed: boolean;
}

export interface SlackDeliveryStore {
  load: (instanceId: string) => SlackDeliveryRecord | undefined;
  save: (instanceId: string, record: SlackDeliveryRecord) => void;
}

interface SqlExec {
  exec: (query: string, ...bindings: string[]) => { toArray: () => unknown[] };
}

const deliveryRow = v.object({ payload: v.string() });

const slackDeliveryRecordSchema = v.object({
  binding: slackDeliveryBindingSchema,
  closed: v.boolean(),
  events: v.array(
    v.union([
      v.object({ text: v.string(), type: v.literal("text") }),
      v.object({
        id: v.string(),
        name: v.string(),
        type: v.literal("tool-start"),
      }),
      v.object({
        error: v.boolean(),
        id: v.string(),
        output: v.string(),
        type: v.literal("tool-result"),
      }),
    ]),
  ),
  failed: v.boolean(),
  replyText: v.string(),
});

export const createSqlSlackDeliveryStore = (
  sql: SqlExec,
): SlackDeliveryStore => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS slack_delivery (
      instance_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    )
  `);
  return {
    load(instanceId) {
      const [row] = sql
        .exec(
          "SELECT payload FROM slack_delivery WHERE instance_id = ?",
          instanceId,
        )
        .toArray();
      let record: SlackDeliveryRecord | undefined;
      if (row !== undefined && v.is(deliveryRow, row)) {
        record = v.parse(slackDeliveryRecordSchema, JSON.parse(row.payload));
      }
      return record;
    },
    save(instanceId, record) {
      sql.exec(
        `INSERT INTO slack_delivery (instance_id, payload) VALUES (?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET payload = excluded.payload`,
        instanceId,
        JSON.stringify(record),
      );
    },
  };
};

type SlackRequestBody = Record<string, string | SlackTaskChunk[]>;

export const COALESCE_CHARS = 1024;
export const COALESCE_MS = 300;
const MAX_SLACK_ATTEMPTS = 4;
// A throttled Slack call answers with the seconds left in the window it just
// closed, and a Tier 2 window is one minute, so a wait past this is not the
// window that blocked the call.
export const MAX_RETRY_AFTER_MS = 60_000;
// A phase of a stream waits out at most that one window before it must deliver
// or fail.
export const MAX_RETRY_WAIT_MS = 60_000;

interface RetryBudget {
  waitedMs: number;
}

const retryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

// An absent header is not a zero-second window: `Number(null)` is 0, and
// reading it as one announced wait leaves the backoff below unreachable.
const announcedRetryMs = (response: Response): number | undefined => {
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
};

interface RetryWait {
  readonly delayMs: number;
  readonly last: boolean;
}

// Slack announces the seconds left in the window it just closed, so the part of
// that window a phase can still fund is not wasted: it is a part the next phase
// no longer has to wait. It cannot end the window on its own though, so a wait
// short of what Slack asked for is the phase's last one. Retrying after it only
// spends attempts at zero delay against a server that has already said no.
export const retryWait = (
  response: Response,
  attempt: number,
  waitedMs: number,
): RetryWait => {
  const requested =
    announcedRetryMs(response) ?? Math.min(250 * 2 ** attempt, 4000);
  const affordable = Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(0, MAX_RETRY_WAIT_MS - waitedMs),
  );
  return {
    delayMs: Math.min(requested, affordable),
    last: requested > affordable,
  };
};

const wait = async (ms: number) => {
  const deferred = Promise.withResolvers<true>();
  setTimeout(() => {
    deferred.resolve(true);
  }, ms);
  await deferred.promise;
};

const toolOutputText = v.union([
  v.string(),
  v.pipe(
    v.unknown(),
    v.transform((value) =>
      value === undefined || value === null ? "" : JSON.stringify(value),
    ),
  ),
]);

export const createSlackStream = (
  target: SlackStreamTarget,
  token: string,
  fetcher: Fetcher = fetch,
  sleep: (ms: number) => Promise<void> = wait,
): SlackStream => {
  const { channelId } = target;
  const sanitizer = createStreamSanitizer();
  let queue: Promise<void> = Promise.resolve();
  let streamTs: string | undefined;
  let appended = false;
  let closed = false;
  let failure: Error | undefined;
  let pending = "";
  let streamed = 0;
  let truncated = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  const contentBudget: RetryBudget = { waitedMs: 0 };
  // The notice is the last thing this stream can say to the user, so it starts
  // from its own window: a stream body that already spent the content budget
  // must not be able to swallow the notice as well.
  const closingBudget: RetryBudget = { waitedMs: 0 };

  const retry = async (
    response: Response,
    attempt: number,
    budget: RetryBudget,
  ): Promise<boolean> => {
    const { delayMs, last } = retryWait(response, attempt, budget.waitedMs);
    budget.waitedMs += delayMs;
    await sleep(delayMs);
    return !last;
  };

  const call = async (
    method: string,
    body: SlackRequestBody,
    budget: RetryBudget,
  ) => {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_SLACK_ATTEMPTS; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetcher(`https://slack.com/api/${method}`, {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        method: "POST",
      });
      if (retryableStatus(response.status)) {
        lastError = new Error(`Slack ${method} failed: ${response.status}`);
        if (attempt + 1 === MAX_SLACK_ATTEMPTS) {
          throw lastError;
        }
        // oxlint-disable-next-line no-await-in-loop
        if (!(await retry(response, attempt, budget))) {
          throw lastError;
        }
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const payload: unknown = await response.json();
      const result = v.parse(slackResult, payload);
      if (result.ok === true) {
        return result;
      }
      lastError = new Error(
        `Slack ${method} failed: ${result.error ?? response.status}`,
      );
      if (
        (result.error !== "rate_limited" &&
          result.error !== "internal_error" &&
          result.error !== "service_unavailable") ||
        attempt + 1 === MAX_SLACK_ATTEMPTS
      ) {
        throw lastError;
      }
      // oxlint-disable-next-line no-await-in-loop
      if (!(await retry(response, attempt, budget))) {
        throw lastError;
      }
    }
    throw lastError ?? new Error(`Slack ${method} failed`);
  };

  const start = async (budget: RetryBudget): Promise<string> => {
    if (streamTs !== undefined) {
      return streamTs;
    }
    const result = await call(
      "chat.startStream",
      target.surface === "channel"
        ? {
            channel: channelId,
            recipient_team_id: target.recipientTeamId,
            recipient_user_id: target.recipientUserId,
            task_display_mode: "timeline",
            thread_ts: target.threadTs,
          }
        : {
            channel: channelId,
            task_display_mode: "timeline",
            thread_ts: target.threadTs,
          },
      budget,
    );
    if (result.ts === undefined) {
      throw new Error("Slack chat.startStream returned no stream ts");
    }
    streamTs = result.ts;
    return streamTs;
  };

  const clipMarkdown = (markdown: string): string => {
    if (truncated || markdown === "") {
      return "";
    }
    if (streamed + markdown.length <= MAX_SLACK_MESSAGE_LENGTH) {
      streamed += markdown.length;
      return markdown;
    }
    const room = MAX_SLACK_MESSAGE_LENGTH - 20 - streamed;
    let head = "";
    if (room > 0) {
      head = clipUtf16(markdown, room);
    }
    truncated = true;
    const clipped = `${head}${TRUNCATION_NOTICE}`;
    streamed += clipped.length;
    return clipped;
  };

  const post = async (markdown: string, budget: RetryBudget): Promise<void> => {
    if (!markdown) {
      return;
    }
    const ts = await start(budget);
    for (
      let offset = 0;
      offset < markdown.length;
      offset += MAX_SLACK_APPEND_LENGTH
    ) {
      // Appends must land in the order the model produced them.
      // oxlint-disable-next-line no-await-in-loop
      await call(
        "chat.appendStream",
        {
          channel: channelId,
          markdown_text: markdown.slice(
            offset,
            offset + MAX_SLACK_APPEND_LENGTH,
          ),
          ts,
        },
        budget,
      );
      appended = true;
    }
  };

  const send = async (markdown: string, budget: RetryBudget): Promise<void> => {
    await post(clipMarkdown(markdown), budget);
  };

  // A task update rides the same append call as reply text but never sets
  // `appended`: a turn that only ran tools still owes the user a reply.
  const sendTask = async (
    update: SlackTaskUpdate,
    budget: RetryBudget,
  ): Promise<void> => {
    const ts = await start(budget);
    const output =
      update.output === undefined ? "" : sanitizeTaskText(update.output);
    const chunk: SlackTaskChunk = {
      id: update.id === "" ? "_" : update.id,
      status: update.status,
      title: sanitizeTaskText(update.title, SLACK_TASK_FALLBACK_TITLE),
      type: "task_update",
    };
    if (output !== "") {
      chunk.output = output;
    }
    await call(
      "chat.appendStream",
      {
        channel: channelId,
        chunks: [clampTaskChunk(chunk)],
        ts,
      },
      budget,
    );
  };

  const attempt = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error: unknown) {
      failure ??=
        error instanceof Error
          ? error
          : new Error("Slack streaming delivery failed", { cause: error });
    }
  };

  const guarded = async (work: () => Promise<void>): Promise<void> => {
    if (failure !== undefined) {
      return;
    }
    await attempt(work);
  };

  const enqueue = (work: () => Promise<void>): void => {
    const previous = queue;
    queue = (async () => {
      await previous;
      await guarded(work);
    })();
  };

  const flushPending = (): void => {
    if (coalesceTimer !== undefined) {
      clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
    }
    const markdown = pending;
    pending = "";
    if (markdown) {
      enqueue(() => send(markdown, contentBudget));
    }
  };

  const bufferAppend = (safe: string): void => {
    if (!safe) {
      return;
    }
    pending += safe;
    if (pending.length >= COALESCE_CHARS) {
      flushPending();
      return;
    }
    coalesceTimer ??= setTimeout(() => {
      coalesceTimer = undefined;
      flushPending();
    }, COALESCE_MS);
  };

  const close = async (trailer: string, always: boolean): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    flushPending();
    enqueue(() => send(sanitizer.flush(), contentBudget));
    await queue;
    // A recorded failure must reach the user on whichever path closes the
    // stream: otherwise they keep the partial content with nothing telling them
    // the turn broke. `closed` keeps it to one notice per stream.
    if (always || !appended || failure !== undefined) {
      const notice =
        failure === undefined ? trailer : SLACK_STREAM_FAILURE_NOTICE;
      // `post`, not `send`: the closing word is not stream content, and a reply
      // that already hit the content cap would otherwise clip it away and leave
      // the user with a truncated answer and no sign the turn broke.
      await attempt(() => post(sanitizeReply(notice), closingBudget));
    }
    const ts = streamTs;
    if (ts === undefined) {
      return;
    }
    await attempt(async () => {
      await call("chat.stopStream", { channel: channelId, ts }, closingBudget);
    });
  };

  return {
    append(delta) {
      if (closed) {
        return;
      }
      bufferAppend(sanitizer.push(delta));
    },
    async fail(notice) {
      await close(notice, true);
    },
    async finish(fallback) {
      await close(fallback, false);
      if (failure !== undefined) {
        throw failure;
      }
    },
    task(update) {
      if (closed) {
        return;
      }
      flushPending();
      enqueue(() => sendTask(update, contentBudget));
    },
  };
};

const toolErrorText = (event: {
  errorInfo?: { message?: string };
  result?: unknown;
}): string => {
  const fromInfo = event.errorInfo?.message?.trim() ?? "";
  if (fromInfo !== "") {
    return fromInfo;
  }
  return v.parse(toolOutputText, event.result);
};

export const slackEventFromObservation = (
  event: FlueObservation,
): SlackDeliveryEvent | "fail" | undefined => {
  if (event.type === "text_delta") {
    return { text: event.text, type: "text" };
  }
  if (event.type === "tool_start") {
    return { id: event.toolCallId, name: event.toolName, type: "tool-start" };
  }
  if (event.type === "tool") {
    return {
      error: event.isError,
      id: event.toolCallId,
      output: event.isError
        ? toolErrorText(event)
        : v.parse(toolOutputText, event.effectiveResult ?? event.result),
      type: "tool-result",
    };
  }
  if (event.type === "submission_settled" && event.outcome !== "completed") {
    return "fail";
  }
  return undefined;
};

const applyDeliveryEvent = (
  stream: SlackStream,
  toolNames: Map<string, string>,
  event: SlackDeliveryEvent,
): void => {
  if (event.type === "text") {
    stream.append(event.text);
    return;
  }
  if (event.type === "tool-start") {
    toolNames.set(event.id, event.name);
    stream.task({
      id: event.id,
      status: "in_progress",
      title: event.name,
    });
    return;
  }
  stream.task({
    id: event.id,
    output: event.output,
    status: event.error ? "error" : "complete",
    title: toolNames.get(event.id) ?? "",
  });
};

const feedSlackStream = (
  stream: SlackStream,
  events: readonly SlackDeliveryEvent[],
): void => {
  const toolNames = new Map<string, string>();
  for (const event of events) {
    applyDeliveryEvent(stream, toolNames, event);
  }
};

const replyTrailer = (replyText: string): string =>
  replyText === "" ? SLACK_DELIVERY_FALLBACK : replyText;

const HIGH_SURROGATE_TAIL = /[\uD800-\uDBFF]$/u;
const ORPHAN_LOW_SURROGATE_TAIL = /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]$/u;

// At the cap no later delta can complete a trailing high half, and the low half
// that follows one already dropped here arrives without its partner.
const clipDurableText = (text: string): string => {
  const kept = text.slice(0, MAX_DURABLE_REPLY_LENGTH);
  const atCap = kept.length === MAX_DURABLE_REPLY_LENGTH;
  return (atCap && HIGH_SURROGATE_TAIL.test(kept)) ||
    ORPHAN_LOW_SURROGATE_TAIL.test(kept)
    ? kept.slice(0, -1)
    : kept;
};

const appendDurableText = (current: string, delta: string): string =>
  current.length >= MAX_DURABLE_REPLY_LENGTH
    ? current
    : clipDurableText(current + delta);

// One merged text event per run of deltas: a replay only ever needs the text,
// and an event per 4-character delta is what made every save quadratic.
const applyRecordEvent = (
  record: SlackDeliveryRecord,
  event: SlackDeliveryEvent,
): void => {
  if (event.type !== "text") {
    record.events.push(event);
    return;
  }
  record.replyText = appendDurableText(record.replyText, event.text);
  const last = record.events.at(-1);
  if (last?.type === "text") {
    last.text = appendDurableText(last.text, event.text);
    return;
  }
  record.events.push({ text: clipDurableText(event.text), type: "text" });
};

interface LiveSlackDelivery {
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  pendingText: number;
  record: SlackDeliveryRecord;
  store: SlackDeliveryStore;
  stream: SlackStream;
  toolNames: Map<string, string>;
}

const liveDeliveries = new Map<string, LiveSlackDelivery>();

const flushLiveDelivery = (
  instanceId: string,
  live: LiveSlackDelivery,
): void => {
  if (live.flushTimer !== undefined) {
    clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
  }
  live.pendingText = 0;
  live.store.save(instanceId, live.record);
};

const scheduleFlush = (instanceId: string, live: LiveSlackDelivery): void => {
  live.flushTimer ??= setTimeout(() => {
    live.flushTimer = undefined;
    flushLiveDelivery(instanceId, live);
  }, COALESCE_MS);
};

const closeLiveDelivery = (
  store: SlackDeliveryStore,
  instanceId: string,
  live: LiveSlackDelivery | undefined,
  record: SlackDeliveryRecord,
): void => {
  liveDeliveries.delete(instanceId);
  record.closed = true;
  if (live === undefined) {
    store.save(instanceId, record);
    return;
  }
  flushLiveDelivery(instanceId, live);
};

export const evictLiveSlackDelivery = (instanceId?: string): void => {
  if (instanceId === undefined) {
    for (const [id, live] of liveDeliveries) {
      flushLiveDelivery(id, live);
    }
    liveDeliveries.clear();
    return;
  }
  const live = liveDeliveries.get(instanceId);
  if (live !== undefined) {
    flushLiveDelivery(instanceId, live);
    liveDeliveries.delete(instanceId);
  }
};

const runSlackAlarmDelivery = async (
  binding: SlackDeliveryBinding,
  token: string,
  work: {
    events: readonly SlackDeliveryEvent[];
    replyText: string;
  },
  fetcher: Fetcher = fetch,
): Promise<void> => {
  const stream = createSlackStream(
    streamTargetFromBinding(binding),
    token,
    fetcher,
  );
  feedSlackStream(stream, work.events);
  // No `fail` on the way out: `finish` already sent the failure notice and
  // closed the stream before it rethrows.
  await stream.finish(replyTrailer(work.replyText));
};

const emptyRecord = (binding: SlackDeliveryBinding): SlackDeliveryRecord => ({
  binding,
  closed: false,
  events: [],
  failed: false,
  replyText: "",
});

export const openSlackDelivery = (
  store: SlackDeliveryStore,
  instanceId: string,
  binding: SlackDeliveryBinding,
  token: string,
  fetcher: Fetcher = fetch,
): void => {
  if (liveDeliveries.has(instanceId)) {
    return;
  }
  const existing = store.load(instanceId);
  const record =
    existing !== undefined && !existing.closed
      ? existing
      : emptyRecord(binding);
  store.save(instanceId, record);
  liveDeliveries.set(instanceId, {
    flushTimer: undefined,
    pendingText: 0,
    record,
    store,
    stream: createSlackStream(
      streamTargetFromBinding(record.binding),
      token,
      fetcher,
    ),
    toolNames: new Map(),
  });
};

export const applySlackDeliveryEvent = (
  store: SlackDeliveryStore,
  instanceId: string,
  event: SlackDeliveryEvent,
): void => {
  const live = liveDeliveries.get(instanceId);
  if (live !== undefined) {
    applyRecordEvent(live.record, event);
    applyDeliveryEvent(live.stream, live.toolNames, event);
    if (event.type !== "text") {
      flushLiveDelivery(instanceId, live);
      return;
    }
    live.pendingText += event.text.length;
    if (live.pendingText >= COALESCE_CHARS) {
      flushLiveDelivery(instanceId, live);
      return;
    }
    scheduleFlush(instanceId, live);
    return;
  }
  const record = store.load(instanceId);
  if (record === undefined || record.closed) {
    return;
  }
  applyRecordEvent(record, event);
  store.save(instanceId, record);
};

export const failSlackDelivery = async (
  store: SlackDeliveryStore,
  instanceId: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<void> => {
  const live = liveDeliveries.get(instanceId);
  const record = live?.record ?? store.load(instanceId);
  if (record === undefined || record.closed) {
    return;
  }
  record.failed = true;
  try {
    if (live !== undefined) {
      await live.stream.fail(SLACK_STREAM_FAILURE_NOTICE);
      return;
    }
    const stream = createSlackStream(
      streamTargetFromBinding(record.binding),
      token,
      fetcher,
    );
    feedSlackStream(stream, record.events);
    await stream.fail(SLACK_STREAM_FAILURE_NOTICE);
  } finally {
    closeLiveDelivery(store, instanceId, live, record);
  }
};

export const finishSlackDelivery = async (
  store: SlackDeliveryStore,
  instanceId: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<void> => {
  const live = liveDeliveries.get(instanceId);
  const record = live?.record ?? store.load(instanceId);
  if (record === undefined || record.closed) {
    return;
  }
  if (record.failed) {
    await failSlackDelivery(store, instanceId, token, fetcher);
    return;
  }
  const trailer = replyTrailer(record.replyText);
  try {
    if (live !== undefined) {
      await live.stream.finish(trailer);
      return;
    }
    await runSlackAlarmDelivery(
      record.binding,
      token,
      {
        events: record.events.filter((event) => event.type !== "text"),
        replyText: trailer,
      },
      fetcher,
    );
  } catch {
    // Slack already received the failure notice. Throwing would fail a
    // completed turn and the runtime would retry the submission, posting twice.
  } finally {
    closeLiveDelivery(store, instanceId, live, record);
  }
};
