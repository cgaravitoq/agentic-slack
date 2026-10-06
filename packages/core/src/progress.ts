import { timingSafeEqual } from "node:crypto";
import type { SlackThreadRef } from "@flue/slack";
import * as v from "valibot";
import { createSqlSlackChannelAdmissionStore } from "./admission.ts";
import { claimAndRun } from "./dedup.ts";
import { MAX_SLACK_MESSAGE_LENGTH } from "./delivery.ts";
import type { SlackDeliveryBinding } from "./delivery.ts";
import { readThreadReplies } from "./read.ts";

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
  narration?: string;
}

export interface ResolvedSlackProgressConfig {
  readonly authSecret: string;
  readonly labels: Readonly<Record<ProgressKind, string>>;
  readonly narration?: string;
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
  const narration = progress.narration?.trim();
  if (narration === "") {
    throw new Error("Agent config requires progress narration");
  }
  return Object.freeze({
    authSecret,
    labels: resolveProgressLabels(progress.labels),
    narration,
  });
};

const MILESTONE_ID_LIMIT = 200;
const TASK_LIMIT = 200;
const TITLE_LIMIT = 300;
// Group DM names run past the 80 Slack bounds a channel name to.
const CHANNEL_LIMIT = 255;
const URL_LIMIT = 2048;

const milestoneSchema = v.object({
  channel: v.pipe(v.string(), v.nonEmpty(), v.maxLength(CHANNEL_LIMIT)),
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

const repliesQuerySchema = v.object({
  channel: v.pipe(v.string(), v.nonEmpty(), v.maxLength(CHANNEL_LIMIT)),
  oldest: v.optional(v.pipe(v.string(), v.regex(/^\d+(?:\.\d+)?$/u))),
  task: v.pipe(v.string(), v.nonEmpty(), v.maxLength(TASK_LIMIT)),
});

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

const slackChannelSchema = v.object({
  is_mpim: v.optional(v.boolean()),
  is_private: v.optional(v.boolean()),
  name: v.optional(v.string()),
});

const conversationsInfoEnvelope = v.object({
  channel: v.optional(slackChannelSchema),
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
});

interface SlackEnvelope {
  readonly error?: string;
  readonly ok?: boolean;
}

interface SlackCaller {
  readonly fetcher: Fetcher;
  readonly token: string;
}

// Slack takes a JSON body on its write methods but answers a read method sent
// one with invalid_arguments, so the body's type picks the encoding.
const callSlack = async <TOutput extends SlackEnvelope>(
  caller: SlackCaller,
  method: string,
  body: Record<string, string> | URLSearchParams,
  schema: v.GenericSchema<unknown, TOutput>,
): Promise<TOutput> => {
  // A fetcher reached through an object would run with that object as its
  // receiver, which workerd's global fetch rejects as an illegal invocation.
  const { fetcher } = caller;
  const form = body instanceof URLSearchParams;
  const response = await fetcher(`${SLACK_API}${method}`, {
    body: form ? body : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${caller.token}`,
      "content-type": form
        ? "application/x-www-form-urlencoded; charset=utf-8"
        : "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const result = v.parse(schema, await response.json());
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
  readonly handleChannels: (request: Request) => Promise<Response>;
  readonly handleReplies: (request: Request) => Promise<Response>;
}

type SlackChannelKind = "channel" | "group" | "private";

interface SlackChannelDescription {
  readonly kind: SlackChannelKind;
  readonly name: string | null;
}

interface SlackProgressChannel {
  readonly id: string;
  readonly kind: SlackChannelKind;
  readonly name: string | null;
}

export interface SlackProgressTurn {
  readonly binding: SlackDeliveryBinding;
  readonly body: string;
  readonly instanceId: string;
}

export interface SlackProgressEndpointOptions {
  readonly bearer: string;
  readonly db: D1Database;
  readonly fetcher?: Fetcher;
  readonly narrate: (turn: SlackProgressTurn) => Promise<void>;
  readonly teamId: string;
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

// The progress route reaches a conversation without an ingress channel object,
// so it spells the canonical id out; worker-stream.test.ts pins it to the id a
// mention in the same thread gets.
export const slackInstanceId = (ref: SlackThreadRef): string =>
  `slack:v1:${encodeURIComponent(ref.teamId)}:${encodeURIComponent(ref.channelId)}:${encodeURIComponent(ref.threadTs)}`;

// Only the voice comes from the operator: a narrated reply may restate the
// milestone and the thread, never facts of its own, so the rule is core's.
const NARRATION_RULE =
  "Rewrite this milestone as your reply in that voice: one or two short sentences that use the earlier milestones in this thread as context and say only what this milestone and those earlier milestones say.";

const narrationBody = (
  milestone: SlackProgressMilestone,
  narration: string,
  labels: Readonly<Record<ProgressKind, string>>,
): string =>
  [
    narration,
    `Task: ${milestone.task}`,
    `Status: ${labels[milestone.kind]}`,
    `Milestone: ${replyOf(milestone)}`,
    NARRATION_RULE,
  ].join("\n\n");

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

type ChannelResolution =
  | { readonly channelId: string }
  | { readonly refusal: "ambiguous_channel" | "channel_not_admitted" };

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

  const authorized = (request: Request): boolean =>
    options.bearer !== "" &&
    constantTimeEquals(
      request.headers.get("authorization") ?? "",
      authorization,
    );

  const describeChannel = async (
    channelId: string,
  ): Promise<SlackChannelDescription> => {
    try {
      const { channel } = await callSlack(
        caller,
        "conversations.info",
        new URLSearchParams({ channel: channelId }),
        conversationsInfoEnvelope,
      );
      if (channel === undefined) {
        return { kind: "channel", name: null };
      }
      let kind: SlackChannelKind = "channel";
      if (channel.is_mpim === true) {
        kind = "group";
      } else if (channel.is_private === true) {
        kind = "private";
      }
      return { kind, name: channel.name ?? null };
    } catch {
      // A channel Slack will not describe is not a reason to hide it from the
      // client choosing one, nor a channel it can match by name.
      return { kind: "channel", name: null };
    }
  };

  const resolveChannel = async (
    channel: string,
  ): Promise<ChannelResolution> => {
    const admittedChannelIds = await admissionStore.listAdmittedChannelIds();
    if (admittedChannelIds.includes(channel)) {
      return { channelId: channel };
    }
    const name = (
      channel.startsWith("#") ? channel.slice(1) : channel
    ).toLowerCase();
    const descriptions = await Promise.all(
      admittedChannelIds.map(describeChannel),
    );
    const matches = admittedChannelIds.filter(
      (_, index) => descriptions[index]?.name?.toLowerCase() === name,
    );
    const [match] = matches;
    if (match === undefined) {
      return { refusal: "channel_not_admitted" };
    }
    return matches.length === 1
      ? { channelId: match }
      : { refusal: "ambiguous_channel" };
  };

  const rootOf = (milestone: SlackProgressMilestone): string =>
    `${milestone.title} · ${config.labels[milestone.kind]}`;

  const enterRoot = async (
    milestone: SlackProgressMilestone,
    text: string,
  ): Promise<SlackProgressRoot> => {
    const stored = await roots.load(milestone.channel, milestone.task);
    if (stored === undefined) {
      const posted = await callSlack(
        caller,
        "chat.postMessage",
        {
          channel: milestone.channel,
          text,
        },
        slackEnvelope,
      );
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
        await callSlack(
          caller,
          "chat.update",
          {
            channel: milestone.channel,
            text,
            ts: stored.rootTs,
          },
          slackEnvelope,
        );
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

  const postReply = async (
    channelId: string,
    threadTs: string,
    text: string,
  ): Promise<void> => {
    await callSlack(
      caller,
      "chat.postMessage",
      {
        channel: channelId,
        text,
        thread_ts: threadTs,
      },
      slackEnvelope,
    );
  };

  const narrateMilestone = async (
    milestone: SlackProgressMilestone,
    admittedBy: string,
    root: SlackProgressRoot,
    narration: string,
    reply: string,
  ): Promise<void> => {
    try {
      await options.narrate({
        binding: {
          channelId: milestone.channel,
          fallbackText: reply,
          recipientTeamId: options.teamId,
          recipientUserId: admittedBy,
          surface: "channel",
          threadTs: root.rootTs,
        },
        body: narrationBody(milestone, narration, config.labels),
        instanceId: slackInstanceId({
          channelId: milestone.channel,
          teamId: options.teamId,
          threadTs: root.rootTs,
        }),
      });
    } catch (error: unknown) {
      // The turn never reached the thread, so the milestone still must.
      console.error("Slack progress narration failed", error);
      await postReply(milestone.channel, root.rootTs, reply);
    }
  };

  const postMilestone = async (
    milestone: SlackProgressMilestone,
    admittedBy: string,
  ): Promise<void> => {
    const root = await enterRoot(milestone, rootOf(milestone));
    const reply = replyOf(milestone);
    const { narration } = config;
    if (narration === undefined) {
      await postReply(milestone.channel, root.rootTs, reply);
      return;
    }
    await narrateMilestone(milestone, admittedBy, root, narration, reply);
  };

  return {
    authSecret: config.authSecret,
    async handle(request) {
      if (!authorized(request)) {
        return refusal(401, "unauthorized");
      }
      const milestone = await milestoneFrom(request);
      if (milestone === undefined) {
        return refusal(400, "invalid_request");
      }
      const resolved = await resolveChannel(milestone.channel);
      if ("refusal" in resolved) {
        return refusal(
          resolved.refusal === "ambiguous_channel" ? 409 : 403,
          resolved.refusal,
        );
      }
      const admittedBy = await admissionStore.admittedBy(resolved.channelId);
      if (admittedBy === undefined) {
        return refusal(403, "channel_not_admitted");
      }
      const resolvedMilestone = {
        ...milestone,
        channel: resolved.channelId,
      };
      try {
        await claimAndRun(options.db, `progress:${resolvedMilestone.id}`, () =>
          postMilestone(resolvedMilestone, admittedBy),
        );
      } catch (error: unknown) {
        console.error("Slack progress milestone failed", error);
        return refusal(500, "slack_failed");
      }
      return Response.json({ ok: true });
    },
    async handleChannels(request) {
      if (!authorized(request)) {
        return refusal(401, "unauthorized");
      }
      const admittedChannelIds = await admissionStore.listAdmittedChannelIds();
      const channels: SlackProgressChannel[] = await Promise.all(
        admittedChannelIds.map(async (id) => ({
          id,
          ...(await describeChannel(id)),
        })),
      );
      return Response.json({ channels, ok: true });
    },
    async handleReplies(request) {
      if (!authorized(request)) {
        return refusal(401, "unauthorized");
      }
      const query = v.safeParse(
        repliesQuerySchema,
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) {
        return refusal(400, "invalid_request");
      }
      const resolved = await resolveChannel(query.output.channel);
      if ("refusal" in resolved) {
        return refusal(
          resolved.refusal === "ambiguous_channel" ? 409 : 403,
          resolved.refusal,
        );
      }
      const root = await roots.load(resolved.channelId, query.output.task);
      if (root === undefined) {
        return refusal(404, "no_thread");
      }
      try {
        const messages = await readThreadReplies(
          caller,
          resolved.channelId,
          root.rootTs,
          query.output.oldest,
        );
        return Response.json({ messages, ok: true });
      } catch (error: unknown) {
        console.error("Slack progress replies failed", error);
        return refusal(500, "slack_failed");
      }
    },
  };
};
