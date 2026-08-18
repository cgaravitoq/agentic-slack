import * as v from "valibot";
import type { ConversationSurface } from "./retention.ts";
import type { RoutedSlackTurn } from "./slack.ts";

const BROADCAST_RE = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/giu;
const SUBTEAM_RE = /<!subteam\^[^>]+>/giu;
const CONTROL_OPENER_RE = /<(?=[@#!])/gu;
const SLACK_TOKEN_RE = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+/gu;
const SECRET_ASSIGNMENT_RE =
  /(?:\\["'])?["']?\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SIGNING_SECRET)[A-Z0-9_]*(?:\\["'])?["']?\s*[:=]\s*(?:\\"[^"\\]*\\"|\\'[^'\\]*\\'|"[^"]*"|'[^']*'|[^,\s"']+)/giu;

// A redaction pattern that is still growing at the end of the buffer would be
// split by an emit, so the tail it could still occupy is withheld instead.
const OPEN_TAIL_RES = [
  /<[^>]*$/u,
  /\S+\s*$/u,
  /\s+$/u,
  /(?:\\["'])?["']?[A-Za-z0-9_]+(?:\\["'])?["']?\s*[:=]\s*(?:\\"[^"\\]*\\"|\\'[^'\\]*\\'|"[^"]*"|'[^']*'|\\"[^"\\]*\\?|\\'[^'\\]*\\?|"[^"]*|'[^']*|[^,\s"']*)\s*$/u,
];

export const MAX_SLACK_MESSAGE_LENGTH = 3900;
export const MAX_SLACK_APPEND_LENGTH = 12_000;
export const MAX_SLACK_TASK_CHUNK_LENGTH = 256;

export const SLACK_TASK_FALLBACK_TITLE = "Step";

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

// Task chunks are one-line labels, so the shared redaction runs over text
// whose newlines have already collapsed. Length is left to `clampTaskChunk`,
// which spends the budget across the whole chunk rather than per field.
export const sanitizeTaskText = (text: string, fallback = ""): string => {
  const safe = redact(text).replaceAll(/\s+/gu, " ").trim();
  return safe === "" ? fallback : safe;
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
    safe = `${safe.slice(0, maxLength - 20).trimEnd()}\n\n(truncated)`;
  }
  return safe;
};

const openTailIndex = (buffer: string): number => {
  let cut = buffer.length;
  for (const pattern of OPEN_TAIL_RES) {
    const match = pattern.exec(buffer);
    if (match && match.index < cut) {
      cut = match.index;
    }
  }
  return cut;
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
  return {
    flush() {
      const rest = buffer;
      buffer = "";
      return emit(rest).trimEnd();
    },
    push(delta) {
      buffer += delta;
      const cut = openTailIndex(buffer);
      if (cut === 0) {
        return "";
      }
      const head = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return emit(head);
    },
  };
};

// What the types enforce: the brand is module-private, so a destination cannot
// be written as a literal (TS2741) nor have a field reassigned (TS2540), and
// the frozen result rejects Object.assign at runtime. What they do not enforce:
// object spread copies the brand, so `{ ...streamTargetFor(turn), channelId }`
// still typechecks. The fence against that is the worker-level test "keeps the
// wire destination on the routed channel, not one named in the turn text or the
// deltas", which asserts the wire bodies against the routed event.
const routedOrigin = Symbol("routedOrigin");

export interface SlackStreamTarget {
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

export type SlackTaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface SlackTaskUpdate {
  id: string;
  title: string;
  status: SlackTaskStatus;
  output?: string;
}

// Slack's `task_update` chunk, not the `task_card` block: the chunk keys the
// task on `id` and takes `details`/`output` as plain strings, where the block
// uses `task_id` and rich_text entities.
// `id` is passed through unredacted because Slack never renders it: it is
// only a correlation key, so the rendering-side attacks the sanitizer exists
// to stop (broadcast pings, `<@...>` control sequences, markdown injection)
// are unreachable through that field. An empty runtime id is stored as `_`
// so the chunk stays a valid key. The budget path may still truncate the
// id, and that is accepted. `title` and `output` are the visible text.
interface SlackTaskChunk {
  type: "task_update";
  id: string;
  title: string;
  status: SlackTaskStatus;
  output?: string;
}

// Slack budgets 256 characters per `task_update` chunk without splitting that
// across its fields, and an oversized chunk comes back `invalid_chunks` - a
// rejected append that would cost the user the whole reply. So the serialized
// chunk is what gets measured, and the budget is spent in priority order: the
// output first, then the title down to its fallback, and only then the id,
// which is opaque. `title` is required, so it never empties.
const taskChunkEncoder = new TextEncoder();

// Measured in UTF-8 bytes, which is at least the character count Slack
// documents: overshooting costs a shorter preview, undershooting costs the
// reply. A UTF-16 length would undercount every non-ASCII result.
const oversizeOf = (chunk: SlackTaskChunk): number =>
  taskChunkEncoder.encode(JSON.stringify(chunk)).length -
  MAX_SLACK_TASK_CHUNK_LENGTH;

// The overflow is a byte count but a slice is indexed in UTF-16 units, so the
// cut is scaled by the text's own bytes-per-unit rather than subtracted raw,
// which would erase a multibyte field wholesale on the first pass.
const trimTaskField = (text: string, overflow: number): string => {
  const bytes = taskChunkEncoder.encode(text).length;
  const drop =
    bytes === 0 ? text.length : Math.ceil((overflow * text.length) / bytes);
  const kept = text.slice(0, Math.max(0, text.length - drop));
  // A slice can land between the halves of a surrogate pair, and the orphan
  // would reach Slack escaped as a replacement character.
  const whole = /[\uD800-\uDBFF]$/u.test(kept) ? kept.slice(0, -1) : kept;
  return whole.trimEnd();
};

const shrinkTaskChunk = (
  chunk: SlackTaskChunk,
  overflow: number,
): SlackTaskChunk | undefined => {
  const { id, output, title, ...rest } = chunk;
  if (output !== undefined) {
    const kept = trimTaskField(output, overflow);
    return kept === ""
      ? { ...rest, id, title }
      : { ...rest, id, output: kept, title };
  }
  if (title !== SLACK_TASK_FALLBACK_TITLE) {
    const kept = trimTaskField(title, overflow);
    return {
      ...rest,
      id,
      title: kept === "" ? SLACK_TASK_FALLBACK_TITLE : kept,
    };
  }
  if (id.length > 1) {
    return {
      ...rest,
      id: id.slice(0, Math.max(1, id.length - overflow)),
      title,
    };
  }
  return undefined;
};

const clampTaskChunk = (chunk: SlackTaskChunk): SlackTaskChunk => {
  let fitted = chunk;
  let overflow = oversizeOf(fitted);
  while (overflow > 0) {
    const next = shrinkTaskChunk(fitted, overflow) ?? fitted;
    // Identity is the no-progress case: shrink returned undefined, so
    // `?? fitted` reused the current chunk and further passes cannot help.
    if (next === fitted) {
      return next;
    }
    fitted = next;
    overflow = oversizeOf(next);
  }
  return fitted;
};

export interface SlackStream {
  append: (delta: string) => void;
  task: (update: SlackTaskUpdate) => void;
  finish: (fallback: string) => Promise<void>;
  fail: (notice: string) => Promise<void>;
}

type SlackRequestBody = Record<string, string | SlackTaskChunk[]>;

export const createSlackStream = (
  target: SlackStreamTarget,
  token: string,
  fetcher: Fetcher = fetch,
): SlackStream => {
  const { channelId } = target;
  const sanitizer = createStreamSanitizer();
  let queue: Promise<void> = Promise.resolve();
  let streamTs: string | undefined;
  let appended = false;
  let closed = false;
  let failure: Error | undefined;

  const call = async (method: string, body: SlackRequestBody) => {
    const response = await fetcher(`https://slack.com/api/${method}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
    });
    const result = v.parse(slackResult, await response.json());
    if (result.ok !== true) {
      throw new Error(
        `Slack ${method} failed: ${result.error ?? response.status}`,
      );
    }
    return result;
  };

  const start = async (): Promise<string> => {
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
    );
    if (result.ts === undefined) {
      throw new Error("Slack chat.startStream returned no stream ts");
    }
    streamTs = result.ts;
    return streamTs;
  };

  const send = async (markdown: string): Promise<void> => {
    if (!markdown) {
      return;
    }
    const ts = await start();
    for (
      let offset = 0;
      offset < markdown.length;
      offset += MAX_SLACK_APPEND_LENGTH
    ) {
      // Appends must land in the order the model produced them.
      // oxlint-disable-next-line no-await-in-loop
      await call("chat.appendStream", {
        channel: channelId,
        markdown_text: markdown.slice(offset, offset + MAX_SLACK_APPEND_LENGTH),
        ts,
      });
      appended = true;
    }
  };

  // A task update rides the same append call as reply text but never sets
  // `appended`: a turn that only ran tools still owes the user a reply.
  const sendTask = async (update: SlackTaskUpdate): Promise<void> => {
    const ts = await start();
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
    await call("chat.appendStream", {
      channel: channelId,
      chunks: [clampTaskChunk(chunk)],
      ts,
    });
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

  const close = async (trailer: string, always: boolean): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    enqueue(() => send(sanitizer.flush()));
    await queue;
    // A recorded failure must reach the user on whichever path closes the
    // stream: otherwise they keep the partial content with nothing telling them
    // the turn broke. `closed` keeps it to one notice per stream.
    if (always || !appended || failure !== undefined) {
      const notice =
        failure === undefined ? trailer : SLACK_STREAM_FAILURE_NOTICE;
      await attempt(() => send(sanitizeReply(notice)));
    }
    const ts = streamTs;
    if (ts === undefined) {
      return;
    }
    await attempt(async () => {
      await call("chat.stopStream", { channel: channelId, ts });
    });
  };

  return {
    append(delta) {
      const safe = sanitizer.push(delta);
      if (safe) {
        enqueue(() => send(safe));
      }
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
      enqueue(() => sendTask(update));
    },
  };
};
