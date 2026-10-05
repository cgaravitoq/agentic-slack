import { timingSafeEqual } from "node:crypto";
import * as v from "valibot";
import { createSqlSlackChannelAdmissionStore } from "./admission.ts";
import { claimAndRun } from "./dedup.ts";
import { MAX_SLACK_MESSAGE_LENGTH } from "./delivery.ts";

const PROGRESS_KINDS = [
  "started",
  "progress",
  "blocked",
  "pr",
  "review",
  "merged",
  "done",
] as const;

type ProgressKind = (typeof PROGRESS_KINDS)[number];

type SlackProgressLabels = Partial<Record<ProgressKind, string>>;

export interface SlackProgressConfig {
  authSecret: string;
  labels: SlackProgressLabels;
}

export interface ResolvedSlackProgressConfig {
  readonly authSecret: string;
  readonly labels: Readonly<Record<ProgressKind, string>>;
}

const resolveProgressLabels = (
  labels: SlackProgressLabels,
): Readonly<Record<ProgressKind, string>> => {
  const labelOf = (kind: ProgressKind): string => {
    const label = labels[kind]?.trim() ?? "";
    if (!label) {
      throw new Error(`Agent config requires a progress label for ${kind}`);
    }
    return label;
  };
  return Object.freeze({
    blocked: labelOf("blocked"),
    done: labelOf("done"),
    merged: labelOf("merged"),
    pr: labelOf("pr"),
    progress: labelOf("progress"),
    review: labelOf("review"),
    started: labelOf("started"),
  });
};

export const resolveSlackProgressConfig = (
  progress: SlackProgressConfig | undefined,
): ResolvedSlackProgressConfig | undefined => {
  if (progress === undefined) {
    return undefined;
  }
  const authSecret = progress.authSecret.trim();
  if (!authSecret) {
    throw new Error("Agent config requires progress authSecret");
  }
  return Object.freeze({
    authSecret,
    labels: resolveProgressLabels(progress.labels),
  });
};

const MILESTONE_ID_LIMIT = 200;
const TASK_LIMIT = 200;
const TITLE_LIMIT = 300;
const CHANNEL_ID_LIMIT = 64;
const URL_LIMIT = 2048;

const milestoneSchema = v.object({
  channel: v.pipe(v.string(), v.nonEmpty(), v.maxLength(CHANNEL_ID_LIMIT)),
  id: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MILESTONE_ID_LIMIT)),
  kind: v.picklist(PROGRESS_KINDS),
  task: v.pipe(v.string(), v.nonEmpty(), v.maxLength(TASK_LIMIT)),
  text: v.pipe(v.string(), v.nonEmpty(), v.maxLength(MAX_SLACK_MESSAGE_LENGTH)),
  title: v.pipe(v.string(), v.nonEmpty(), v.maxLength(TITLE_LIMIT)),
  url: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(URL_LIMIT),
      v.check(
        (value) => URL.canParse(value) && new URL(value).protocol === "https:",
        "url must be an https url",
      ),
    ),
  ),
});

type SlackProgressMilestone = v.InferOutput<typeof milestoneSchema>;

const rootRow = v.object({ root_text: v.string(), root_ts: v.string() });

interface SlackProgressRoot {
  readonly rootText: string;
  readonly rootTs: string;
}

interface SlackProgressRootStore {
  readonly drop: (channelId: string, taskId: string) => Promise<void>;
  readonly load: (
    channelId: string,
    taskId: string,
  ) => Promise<SlackProgressRoot | undefined>;
  readonly save: (
    channelId: string,
    taskId: string,
    root: SlackProgressRoot,
    now: number,
  ) => Promise<void>;
}

export const createSqlSlackProgressRootStore = (
  db: D1Database,
): SlackProgressRootStore => ({
  async drop(channelId, taskId) {
    await db
      .prepare(
        "DELETE FROM slack_progress_roots WHERE channel_id = ?1 AND task_id = ?2",
      )
      .bind(channelId, taskId)
      .run();
  },
  async load(channelId, taskId) {
    const { results } = await db
      .prepare(
        "SELECT root_ts, root_text FROM slack_progress_roots WHERE channel_id = ?1 AND task_id = ?2",
      )
      .bind(channelId, taskId)
      .all();
    const [row] = results;
    return v.is(rootRow, row)
      ? { rootText: row.root_text, rootTs: row.root_ts }
      : undefined;
  },
  async save(channelId, taskId, root, now) {
    await db
      .prepare(
        `INSERT INTO slack_progress_roots (channel_id, task_id, root_ts, root_text, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(channel_id, task_id) DO UPDATE SET root_ts = excluded.root_ts, root_text = excluded.root_text, updated_at = excluded.updated_at`,
      )
      .bind(channelId, taskId, root.rootTs, root.rootText, now)
      .run();
  },
});

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const SLACK_API = "https://slack.com/api/";

const slackEnvelope = v.object({
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
  ts: v.optional(v.string()),
});

interface SlackCaller {
  readonly fetcher: Fetcher;
  readonly token: string;
}

const callSlack = async (
  caller: SlackCaller,
  method: string,
  body: Record<string, string>,
): Promise<v.InferOutput<typeof slackEnvelope>> => {
  const response = await caller.fetcher(`${SLACK_API}${method}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${caller.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const result = v.parse(slackEnvelope, await response.json());
  if (result.ok !== true) {
    throw new Error(
      `Slack ${method} failed: ${result.error ?? response.status}`,
    );
  }
  return result;
};

export interface SlackProgressEndpoint {
  readonly authSecret: string;
  readonly handle: (request: Request) => Promise<Response>;
}

export interface SlackProgressEndpointOptions {
  readonly bearer: string;
  readonly db: D1Database;
  readonly fetcher?: Fetcher;
  readonly token: string;
}

const constantTimeEquals = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const refusal = (status: number, error: string): Response =>
  Response.json({ error, ok: false }, { status });

const isMissingMessage = (error: Error): boolean =>
  error.message.includes("message_not_found");

const replyOf = (milestone: SlackProgressMilestone): string =>
  milestone.url === undefined
    ? milestone.text
    : `${milestone.text}\n${milestone.url}`;

const milestoneFrom = async (
  request: Request,
): Promise<SlackProgressMilestone | undefined> => {
  try {
    const parsed = v.safeParse(milestoneSchema, await request.json());
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
};

export const createSlackProgressEndpoint = (
  config: ResolvedSlackProgressConfig,
  options: SlackProgressEndpointOptions,
): SlackProgressEndpoint => {
  const caller: SlackCaller = {
    fetcher: options.fetcher ?? fetch,
    token: options.token,
  };
  const admissionStore = createSqlSlackChannelAdmissionStore(options.db);
  const roots = createSqlSlackProgressRootStore(options.db);
  const authorization = `Bearer ${options.bearer}`;

  const rootOf = (milestone: SlackProgressMilestone): string =>
    `${milestone.title} · ${config.labels[milestone.kind]}`;

  const enterRoot = async (
    milestone: SlackProgressMilestone,
    text: string,
  ): Promise<SlackProgressRoot> => {
    const stored = await roots.load(milestone.channel, milestone.task);
    if (stored === undefined) {
      const posted = await callSlack(caller, "chat.postMessage", {
        channel: milestone.channel,
        text,
      });
      const rootTs = posted.ts ?? "";
      if (rootTs === "") {
        throw new Error(
          "Slack chat.postMessage answered without a message timestamp",
        );
      }
      const root = { rootText: text, rootTs };
      await roots.save(milestone.channel, milestone.task, root, Date.now());
      return root;
    }
    if (stored.rootText !== text) {
      try {
        await callSlack(caller, "chat.update", {
          channel: milestone.channel,
          text,
          ts: stored.rootTs,
        });
      } catch (error: unknown) {
        // A root Slack refuses to edit must not swallow the milestone: the
        // reply still goes out, and a root Slack no longer has is forgotten so
        // the next milestone posts a fresh one instead of retrying forever.
        console.error("Slack progress root edit failed", error);
        if (error instanceof Error && isMissingMessage(error)) {
          await roots.drop(milestone.channel, milestone.task);
        }
        return stored;
      }
      const root = { rootText: text, rootTs: stored.rootTs };
      await roots.save(milestone.channel, milestone.task, root, Date.now());
      return root;
    }
    return stored;
  };

  const postMilestone = async (
    milestone: SlackProgressMilestone,
  ): Promise<void> => {
    const root = await enterRoot(milestone, rootOf(milestone));
    await callSlack(caller, "chat.postMessage", {
      channel: milestone.channel,
      text: replyOf(milestone),
      thread_ts: root.rootTs,
    });
  };

  return {
    authSecret: config.authSecret,
    async handle(request) {
      const provided = request.headers.get("authorization") ?? "";
      if (
        options.bearer === "" ||
        !constantTimeEquals(provided, authorization)
      ) {
        return refusal(401, "unauthorized");
      }
      const milestone = await milestoneFrom(request);
      if (milestone === undefined) {
        return refusal(400, "invalid_request");
      }
      if (!(await admissionStore.isAdmitted(milestone.channel))) {
        return refusal(403, "channel_not_admitted");
      }
      try {
        await claimAndRun(options.db, `progress:${milestone.id}`, () =>
          postMilestone(milestone),
        );
      } catch (error: unknown) {
        console.error("Slack progress milestone failed", error);
        return refusal(500, "slack_failed");
      }
      return Response.json({ ok: true });
    },
  };
};
