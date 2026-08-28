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
