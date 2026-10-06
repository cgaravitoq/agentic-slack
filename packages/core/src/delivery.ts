import type { FlueObservation } from "@flue/runtime";
import * as v from "valibot";
import type { ConversationSurface } from "./retention.ts";
import type { RoutedSlackTurn } from "./slack.ts";
import { clampTaskChunk, SLACK_TASK_FALLBACK_TITLE } from "./task-chunk.ts";
import type { SlackTaskChunk, SlackTaskUpdate } from "./task-chunk.ts";

const BROADCAST_RE = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/giu;
const SUBTEAM_RE = /<!subteam\^[^>]+>/giu;
const CONTROL_OPENER_RE = /<(?=[@#!])/gu;
const SLACK_LINK_RE = /<(?<url>https?:\/\/[^\s<>|]+)(?:\|(?<label>[^<>]*))?>/gu;
const MAX_HELD_LINK_LENGTH = 2048;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/u;
const SLACK_USER_IDS_RE = /^[UW][A-Z0-9]{2,}(?: [UW][A-Z0-9]{2,})*$/u;
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

// Slack renders neither its own link syntax nor a mention inside streamed
// markdown, so a link the model copied from a Slack message is rewritten to the
// markdown form Slack does render.
export const redact = (text: string): string =>
  text
    .replace(SLACK_LINK_RE, (_, url: string, label?: string) =>
      label === undefined || label.trim() === "" ? url : `[${label}](${url})`,
    )
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
    const opener = buffer.lastIndexOf("<", cut - 1);
    if (
      opener !== -1 &&
      cut - opener <= MAX_HELD_LINK_LENGTH &&
      !buffer.slice(opener, cut).includes(">")
    ) {
      cut = opener;
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
  readonly taskUpdates?: "hidden";
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
  // The text this delivery owes its thread when the turn cannot speak: a
  // delivery with one answers a failure or an empty turn with it instead of
  // the generic notice.
  fallbackText: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SLACK_APPEND_LENGTH)),
  ),
  // Signal attributes are strings, so the tags and links trusted code closes
  // the reply with travel as space-separated user IDs and normalized URLs.
  links: v.optional(
    v.pipe(
      v.string(),
      v.check((value) => value.split(" ").every((url) => URL.canParse(url))),
    ),
  ),
  mentions: v.optional(v.pipe(v.string(), v.regex(SLACK_USER_IDS_RE))),
  recipientTeamId: v.pipe(v.string(), v.minLength(1)),
  recipientUserId: v.pipe(v.string(), v.minLength(1)),
  surface: v.picklist(["channel", "private"]),
  taskUpdates: v.optional(v.literal("hidden")),
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
  Object.freeze<SlackStreamTarget>({
    ...streamTargetFor({
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
    }),
    taskUpdates: binding.taskUpdates,
  });

export interface SlackStream {
  append: (delta: string) => void;
  task: (update: SlackTaskUpdate) => void;
  finish: (
    fallback: string,
    notice?: string,
    closing?: string,
  ) => Promise<void>;
  // True when the closing notice reached the thread. `replyText` posts a reply
  // the stream never saw, the way `finish` posts its fallback.
  fail: (
    notice: string,
    replyText?: string,
    closing?: string,
  ) => Promise<boolean>;
}

export type SlackDeliveryEvent =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-result"; id: string; output: string; error: boolean };

interface AbandonedDelivery {
  binding: SlackDeliveryBinding;
  events: SlackDeliveryEvent[];
  joinedBindings: SlackDeliveryBinding[];
  replyText: string;
  failed: boolean;
  closed: boolean;
}

interface SlackDeliveryRecord extends AbandonedDelivery {
  // Records a later turn abandoned, each still owed a failure notice. They ride
  // the record that replaced them so a crash before the notice leaves a durable
  // copy behind for the next finish to retry.
  abandoned: AbandonedDelivery[];
}

export interface SlackDeliveryStore {
  load: (instanceId: string) => SlackDeliveryRecord | undefined;
  save: (instanceId: string, record: SlackDeliveryRecord) => void;
}

interface SqlExec {
  exec: (query: string, ...bindings: string[]) => { toArray: () => unknown[] };
}

const deliveryRow = v.object({ payload: v.string() });

const deliveryEventSchema = v.union([
  v.object({ text: v.string(), type: v.literal("text") }),
  v.object({
    type: v.literal("mention"),
    userId: v.pipe(v.string(), v.regex(SLACK_USER_ID_RE)),
  }),
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
]);

const deliveryRecordFields = {
  binding: slackDeliveryBindingSchema,
  closed: v.boolean(),
  events: v.array(deliveryEventSchema),
  failed: v.boolean(),
  // Absent on a record written before a response could carry more than one
  // requesting thread, and those records are still readable.
  joinedBindings: v.optional(v.array(slackDeliveryBindingSchema), []),
  replyText: v.string(),
};

const abandonedDeliverySchema = v.object(deliveryRecordFields);

const slackDeliveryRecordSchema = v.object({
  ...deliveryRecordFields,
  abandoned: v.optional(v.array(abandonedDeliverySchema), []),
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

interface SlackMarkdownChunk {
  text: string;
  type: "markdown_text";
}

interface SlackSectionBlock {
  text: { text: string; type: "mrkdwn" };
  type: "section";
}

type SlackRequestBody = Record<
  string,
  string | (SlackMarkdownChunk | SlackTaskChunk | SlackSectionBlock)[]
>;

const slackLinkTarget = (url: string): string =>
  url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "%7C");

const closingMrkdwn = (
  userIds: readonly string[],
  links: readonly string[],
): string =>
  [
    ...[...new Set(userIds)].map((userId) => `<@${userId}>`),
    ...[...new Set(links)].map((url) => `<${slackLinkTarget(url)}>`),
  ].join(" ");

export const COALESCE_CHARS = 1024;
export const COALESCE_MS = 300;
const MAX_SLACK_ATTEMPTS = 4;
// A throttled Slack call answers with the seconds left in the window it just
// closed, and a Tier 2 window is one minute, so a wait past this is not the
// window that blocked the call.
export const MAX_RETRY_AFTER_MS = 60_000;
// One pool per phase, shared by every attempt in it: what a wait spends is gone
// for the attempts behind it, so a phase never sits out more than one window.
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
          // Slack fixes a stream to chunks or to markdown_text on the first
          // append, and task updates need chunks, so text goes as chunks too.
          chunks: [
            {
              text: markdown.slice(offset, offset + MAX_SLACK_APPEND_LENGTH),
              type: "markdown_text",
            },
          ],
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

  const attempt = async (work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error: unknown) {
      failure ??=
        error instanceof Error
          ? error
          : new Error("Slack streaming delivery failed", { cause: error });
      return false;
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

  // Reports whether the closing notice reached the thread, so a caller holding
  // a durable record knows the outcome is delivered rather than merely sent.
  const close = async (
    trailer: string,
    always: boolean,
    failureNotice: string,
    replyText?: string,
    closing = "",
  ): Promise<boolean> => {
    if (closed) {
      return failure === undefined;
    }
    closed = true;
    flushPending();
    enqueue(() => send(sanitizer.flush(), contentBudget));
    await queue;
    if (replyText !== undefined && replyText !== "") {
      // A durable replay posts its reply the way a durable finish posts its
      // fallback, so the two paths sanitize and clip the text identically
      // instead of only agreeing while the stream clips them the same.
      await attempt(() => post(sanitizeReply(replyText), contentBudget));
    }
    let delivered = true;
    // A recorded failure must reach the user on whichever path closes the
    // stream: otherwise they keep the partial content with nothing telling them
    // the turn broke. `closed` keeps it to one notice per stream.
    if (always || !appended || failure !== undefined) {
      const notice = failure === undefined ? trailer : failureNotice;
      // `post`, not `send`: the closing word is not stream content, and a reply
      // that already hit the content cap would otherwise clip it away and leave
      // the user with a truncated answer and no sign the turn broke.
      delivered = await attempt(() =>
        post(sanitizeReply(notice), closingBudget),
      );
    }
    const ts = streamTs;
    if (ts === undefined) {
      return delivered;
    }
    await attempt(async () => {
      await call(
        "chat.stopStream",
        closing === ""
          ? { channel: channelId, ts }
          : {
              blocks: [
                { text: { text: closing, type: "mrkdwn" }, type: "section" },
              ],
              channel: channelId,
              ts,
            },
        closingBudget,
      );
    });
    return delivered;
  };

  return {
    append(delta) {
      if (closed) {
        return;
      }
      bufferAppend(sanitizer.push(delta));
    },
    fail(notice, replyText, closing) {
      return close(notice, true, notice, replyText, closing);
    },
    async finish(fallback, notice = SLACK_STREAM_FAILURE_NOTICE, closing = "") {
      await close(fallback, false, notice, undefined, closing);
      if (failure !== undefined) {
        throw failure;
      }
    },
    task(update) {
      if (closed || target.taskUpdates === "hidden") {
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
  if (event.type === "mention") {
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

const replyTrailer = (
  replyText: string,
  fallbackText: string | undefined,
): string =>
  replyText === "" ? (fallbackText ?? SLACK_DELIVERY_FALLBACK) : replyText;

const failureNotice = (binding: SlackDeliveryBinding): string =>
  binding.fallbackText ?? SLACK_STREAM_FAILURE_NOTICE;

const tokens = (value: string | undefined): string[] =>
  value === undefined ? [] : value.split(" ");

const closingOf = (
  binding: SlackDeliveryBinding,
  events: readonly SlackDeliveryEvent[],
): string =>
  closingMrkdwn(
    [
      ...tokens(binding.mentions),
      ...events.flatMap((event) =>
        event.type === "mention" ? [event.userId] : [],
      ),
    ],
    tokens(binding.links),
  );

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
// and an event per 4-character delta is what made every save quadratic. The
// events carry exactly the merged reply text, split at the non-text events, so
// a durable fail replay and a durable finish replay read one source rather than
// two that only agree while the stream clips them.
const applyRecordEvent = (
  record: SlackDeliveryRecord,
  event: SlackDeliveryEvent,
): void => {
  if (event.type !== "text") {
    record.events.push(event);
    return;
  }
  const previous = record.replyText;
  record.replyText = appendDurableText(previous, event.text);
  const added = record.replyText.slice(previous.length);
  if (added === "") {
    return;
  }
  const last = record.events.at(-1);
  if (last?.type === "text") {
    last.text += added;
    return;
  }
  record.events.push({ text: added, type: "text" });
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

interface SlackDeliveryReplay {
  events: readonly SlackDeliveryEvent[];
  replyText: string;
}

const runSlackAlarmDelivery = async (
  binding: SlackDeliveryBinding,
  token: string,
  work: SlackDeliveryReplay,
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
  await stream.finish(
    replyTrailer(work.replyText, binding.fallbackText),
    failureNotice(binding),
    closingOf(binding, work.events),
  );
};

const emptyRecord = (binding: SlackDeliveryBinding): SlackDeliveryRecord => ({
  abandoned: [],
  binding,
  closed: false,
  events: [],
  failed: false,
  joinedBindings: [],
  replyText: "",
});

const sameDestination = (
  left: SlackDeliveryBinding,
  right: SlackDeliveryBinding,
): boolean =>
  left.channelId === right.channelId && left.threadTs === right.threadTs;

const ownsDestination = (
  record: SlackDeliveryRecord,
  binding: SlackDeliveryBinding,
): boolean =>
  [record.binding, ...record.joinedBindings].some((candidate) =>
    sameDestination(candidate, binding),
  );

// Flue joins a dispatch to a busy instance into the live response, so one
// response carries a `useAgentStart()` run per requesting thread. Every one of
// those threads is owed the reply, so a delivery that joins an open record
// adds its destination instead of being dropped.
// A delivery joining a thread the record already answers still owes that
// thread its own fallback text, tags and links, so the owner carries both
// rather than the joining one being dropped with them.
const adoptDestination = (
  record: SlackDeliveryRecord,
  binding: SlackDeliveryBinding,
): boolean => {
  if (!ownsDestination(record, binding)) {
    record.joinedBindings.push(binding);
    return true;
  }
  const { fallbackText: owed, links, mentions } = binding;
  if (owed === undefined && links === undefined && mentions === undefined) {
    return false;
  }
  const withOwed = (owner: SlackDeliveryBinding): SlackDeliveryBinding => {
    if (!sameDestination(owner, binding)) {
      return owner;
    }
    const merged = { ...owner };
    if (owed !== undefined && owner.fallbackText?.includes(owed) !== true) {
      merged.fallbackText = [owner.fallbackText, owed]
        .filter((text) => text !== undefined)
        .join("\n\n")
        .slice(0, MAX_SLACK_APPEND_LENGTH);
    }
    if (links !== undefined) {
      merged.links = [
        ...new Set([...tokens(owner.links), ...tokens(links)]),
      ].join(" ");
    }
    if (mentions !== undefined) {
      merged.mentions = [
        ...new Set([...tokens(owner.mentions), ...tokens(mentions)]),
      ].join(" ");
    }
    return merged;
  };
  record.binding = withOwed(record.binding);
  record.joinedBindings = record.joinedBindings.map(withOwed);
  return true;
};

// Every requesting thread is owed its own reply, so one destination failing
// must not deny the others: the failing stream has already told its own
// thread, and rethrowing would fail a completed turn, which the runtime would
// then retry and post twice. The result is reported so a durable notice is
// only retired once its thread actually heard it.
const settleDestination = async (
  work: () => Promise<void>,
): Promise<boolean> => {
  try {
    await work();
    return true;
  } catch {
    // Deliberate: that thread already carries its own outcome.
    return false;
  }
};

// A replay carries the record's non-text events and its merged reply text, the
// one text source both the durable finish and the durable fail read.
const deliveryReplay = (record: AbandonedDelivery): SlackDeliveryReplay => ({
  events: record.events.filter((event) => event.type !== "text"),
  replyText: record.replyText,
});

const replaySlackFailure = async (
  binding: SlackDeliveryBinding,
  token: string,
  replay: SlackDeliveryReplay,
  fetcher: Fetcher = fetch,
): Promise<void> => {
  const stream = createSlackStream(
    streamTargetFromBinding(binding),
    token,
    fetcher,
  );
  feedSlackStream(stream, replay.events);
  if (
    !(await stream.fail(
      failureNotice(binding),
      replay.replyText,
      closingOf(binding, replay.events),
    ))
  ) {
    throw new Error("Slack failure notice was not delivered");
  }
};

// The record a fresh turn abandons is about to be replaced in the store, so its
// threads are settled from the copy the fresh record carries, not from the slot
// the fresh record now owns.
const settleAbandonedRecord = async (
  record: AbandonedDelivery,
  token: string,
  fetcher: Fetcher,
): Promise<boolean> => {
  const replay = deliveryReplay(record);
  const results = await Promise.all(
    [record.binding, ...record.joinedBindings].map((binding) =>
      settleDestination(() =>
        replaySlackFailure(binding, token, replay, fetcher),
      ),
    ),
  );
  return results.every(Boolean);
};

const abandonRecord = (record: SlackDeliveryRecord): AbandonedDelivery => ({
  binding: record.binding,
  closed: record.closed,
  events: record.events,
  failed: record.failed,
  joinedBindings: record.joinedBindings,
  replyText: record.replyText,
});

export const openSlackDelivery = (
  store: SlackDeliveryStore,
  instanceId: string,
  binding: SlackDeliveryBinding,
  token: string,
  fetcher: Fetcher = fetch,
): void => {
  const live = liveDeliveries.get(instanceId);
  if (live !== undefined) {
    if (adoptDestination(live.record, binding)) {
      flushLiveDelivery(instanceId, live);
    }
    return;
  }
  const existing = store.load(instanceId);
  // A record left open by an interrupted turn belongs to the thread that
  // opened it. Only that thread, or one that already joined its response,
  // resumes it; a later turn starts its own record so its reply cannot land in
  // the interrupted turn's thread. The new record takes the instance's slot
  // before anything is sent to the interrupted threads, so a concurrent turn
  // joins this record instead of replacing it.
  const abandoned =
    existing !== undefined &&
    !existing.closed &&
    !ownsDestination(existing, binding);
  const resumable = existing !== undefined && !existing.closed && !abandoned;
  const record = resumable ? existing : emptyRecord(binding);
  if (existing !== undefined && !resumable) {
    // A notice Slack refused rides on until a finish delivers it, even when the
    // record carrying it already closed.
    record.abandoned = abandoned
      ? [...existing.abandoned, abandonRecord(existing)]
      : existing.abandoned;
  }
  adoptDestination(record, binding);
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

// The record a fresh turn carries holds the threads of every record it
// abandoned; settle them here, before this turn's own delivery, so their
// notices keep the order they had when those turns were interrupted. A notice
// Slack still refuses stays on the record for the next finish to retry.
const settleAbandonedRecords = async (
  store: SlackDeliveryStore,
  instanceId: string,
  record: SlackDeliveryRecord,
  token: string,
  fetcher: Fetcher,
): Promise<void> => {
  if (record.abandoned.length === 0) {
    return;
  }
  const remaining: AbandonedDelivery[] = [];
  for (const entry of record.abandoned) {
    // oxlint-disable-next-line no-await-in-loop
    if (!(await settleAbandonedRecord(entry, token, fetcher))) {
      remaining.push(entry);
    }
  }
  record.abandoned = remaining;
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
  if (record === undefined) {
    return;
  }
  await settleAbandonedRecords(store, instanceId, record, token, fetcher);
  if (record.closed) {
    return;
  }
  record.failed = true;
  const replay = deliveryReplay(record);
  const primary =
    live === undefined
      ? () => replaySlackFailure(record.binding, token, replay, fetcher)
      : async () => {
          await live.stream.fail(
            failureNotice(record.binding),
            undefined,
            closingOf(record.binding, record.events),
          );
        };
  try {
    await settleDestination(primary);
  } finally {
    await Promise.all(
      record.joinedBindings.map((binding) =>
        settleDestination(() =>
          replaySlackFailure(binding, token, replay, fetcher),
        ),
      ),
    );
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
  if (record === undefined) {
    return;
  }
  if (record.failed) {
    await failSlackDelivery(store, instanceId, token, fetcher);
    return;
  }
  await settleAbandonedRecords(store, instanceId, record, token, fetcher);
  if (record.closed) {
    return;
  }
  const replay = deliveryReplay(record);
  const primary =
    live === undefined
      ? () => runSlackAlarmDelivery(record.binding, token, replay, fetcher)
      : () =>
          live.stream.finish(
            replyTrailer(record.replyText, record.binding.fallbackText),
            failureNotice(record.binding),
            closingOf(record.binding, record.events),
          );
  try {
    await settleDestination(primary);
    await Promise.all(
      record.joinedBindings.map((binding) =>
        settleDestination(() =>
          runSlackAlarmDelivery(binding, token, replay, fetcher),
        ),
      ),
    );
  } finally {
    closeLiveDelivery(store, instanceId, live, record);
  }
};
