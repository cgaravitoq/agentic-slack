import * as v from "valibot";
import type { ConversationSurface } from "./retention.ts";
import type { RoutedSlackTurn } from "./slack.ts";

const BROADCAST_RE = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/giu;
const SUBTEAM_RE = /<!subteam\^[^>]+>/giu;
const CONTROL_OPENER_RE = /<(?=[@#!])/gu;
const SLACK_TOKEN_RE = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+/gu;
const SECRET_ASSIGNMENT_RE =
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SIGNING_SECRET)[A-Z0-9_]*\s*[:=]\s*["']?[^,\s"']+/giu;

// A redaction pattern that is still growing at the end of the buffer would be
// split by an emit, so the tail it could still occupy is withheld instead.
const OPEN_TAIL_RES = [
  /<[^>]*$/u,
  /\S+\s*$/u,
  /\s+$/u,
  /[A-Za-z0-9_]+\s*[:=]\s*["']?[^,\s"']*$/u,
];

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

export interface SlackStream {
  append: (delta: string) => void;
  finish: (fallback: string) => Promise<void>;
  fail: (notice: string) => Promise<void>;
}

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

  const call = async (method: string, body: Record<string, string>) => {
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
            thread_ts: target.threadTs,
          }
        : { channel: channelId, thread_ts: target.threadTs },
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
  };
};
