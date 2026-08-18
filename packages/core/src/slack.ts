import { createSlackChannel } from "@flue/slack";
import type {
  SlackEventCallbackPayload,
  SlackEventsApiPayload,
} from "@flue/slack";
import { claimAndRun } from "./dedup.ts";
import type {
  ConversationLifecycleAgent,
  ConversationSurface,
} from "./retention.ts";

const DISABLED_SIGNING_SECRET = "0".repeat(64);
const LEADING_MENTION_RE = /^\s*<@[^>]+>/u;

const isBotEvent = (event: {
  readonly bot_id?: string;
  readonly bot_profile?: unknown;
}): boolean => (event.bot_id ?? "") !== "" || event.bot_profile !== undefined;

const isEventCallbackEnvelope = (
  payload: SlackEventsApiPayload,
): payload is SlackEventCallbackPayload =>
  payload.type === "event_callback" &&
  payload.team_id !== "" &&
  payload.api_app_id !== "" &&
  payload.event_id !== "";

export interface SlackCoreBindings {
  DB: D1Database;
  FLUE_SLACK_AGENT_AGENT: DurableObjectNamespace<ConversationLifecycleAgent>;
  AI: Ai;
}

export interface TrustedSlackConfig {
  signingSecret: string;
  botToken: string;
  teamId: string;
  appId: string;
}

export interface RoutedSlackTurn {
  kind: "turn";
  eventId: string;
  teamId: string;
  appId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  surface: ConversationSurface;
}

export interface RoutedSlackLifecycle {
  kind: "lifecycle";
  eventId: string;
  teamId: string;
  appId: string;
  channelId: string;
  threadTs: string;
}

export type RoutedSlackEvent = RoutedSlackTurn | RoutedSlackLifecycle;

export interface SlackCoreEnv {
  Bindings: SlackCoreBindings;
}

export const routeSlackEvent = (
  payload: SlackEventsApiPayload,
): RoutedSlackEvent | null => {
  if (!isEventCallbackEnvelope(payload)) {
    return null;
  }
  const { event } = payload;
  if (event.type === "assistant_thread_started") {
    return {
      appId: payload.api_app_id,
      channelId: event.assistant_thread.channel_id,
      eventId: payload.event_id,
      kind: "lifecycle",
      teamId: payload.team_id,
      threadTs: event.assistant_thread.thread_ts,
    };
  }
  if (event.type === "app_mention") {
    const text = event.text?.replace(LEADING_MENTION_RE, "").trim();
    const { user } = event;
    if (isBotEvent(event) || user === undefined || user === "" || !text) {
      return null;
    }
    return {
      appId: payload.api_app_id,
      channelId: event.channel,
      eventId: payload.event_id,
      kind: "turn",
      messageTs: event.ts,
      surface: "channel",
      teamId: payload.team_id,
      text,
      threadTs: event.thread_ts ?? event.ts,
      userId: user,
    };
  }
  if (event.type !== "message") {
    return null;
  }
  if (event.subtype !== undefined || event.channel_type !== "im") {
    return null;
  }
  const text = event.text?.trim() ?? "";
  const { user } = event;
  if (isBotEvent(event) || user === undefined || user === "" || text === "") {
    return null;
  }
  return {
    appId: payload.api_app_id,
    channelId: event.channel,
    eventId: payload.event_id,
    kind: "turn",
    messageTs: event.ts,
    surface: "private",
    teamId: payload.team_id,
    text,
    threadTs: event.thread_ts ?? event.ts,
    userId: user,
  };
};

export const missingReadiness = (
  trusted: TrustedSlackConfig,
  bindings: Partial<SlackCoreBindings>,
): string[] => {
  const missing: string[] = [];
  if (!trusted.signingSecret) {
    missing.push("SLACK_SIGNING_SECRET");
  }
  if (!trusted.botToken) {
    missing.push("SLACK_BOT_TOKEN");
  }
  if (!trusted.teamId) {
    missing.push("SLACK_TEAM_ID");
  }
  if (!trusted.appId) {
    missing.push("SLACK_APP_ID");
  }
  if (!bindings.DB) {
    missing.push("DB");
  }
  if (!bindings.FLUE_SLACK_AGENT_AGENT) {
    missing.push("FLUE_SLACK_AGENT_AGENT");
  }
  if (!bindings.AI) {
    missing.push("AI");
  }
  return missing;
};

export const createSlackIngress = (
  trusted: TrustedSlackConfig,
  handleTurn: (
    turn: RoutedSlackTurn,
    instanceId: string,
    env: SlackCoreBindings,
  ) => Promise<void>,
  handleLifecycle?: (
    lifecycle: RoutedSlackLifecycle,
    env: SlackCoreBindings,
  ) => Promise<void>,
) => {
  const identityComplete = Boolean(
    trusted.signingSecret &&
      trusted.botToken &&
      trusted.teamId &&
      trusted.appId,
  );
  const channel = createSlackChannel<SlackCoreEnv>({
    events({ c, payload }) {
      if (!identityComplete) {
        return;
      }
      const routed = routeSlackEvent(payload);
      if (
        !routed ||
        routed.teamId !== trusted.teamId ||
        routed.appId !== trusted.appId
      ) {
        return;
      }
      const run =
        routed.kind === "turn"
          ? () =>
              handleTurn(
                routed,
                channel.instanceId({
                  channelId: routed.channelId,
                  teamId: routed.teamId,
                  threadTs: routed.threadTs,
                }),
                c.env,
              )
          : handleLifecycle && (() => handleLifecycle(routed, c.env));
      if (!run) {
        return;
      }
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await claimAndRun(c.env.DB, routed.eventId, run);
          } catch (error: unknown) {
            console.error("Slack event handling failed", error);
          }
        })(),
      );
    },
    signingSecret: identityComplete
      ? trusted.signingSecret
      : DISABLED_SIGNING_SECRET,
  });
  return channel;
};
