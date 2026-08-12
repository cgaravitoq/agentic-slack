import { createSlackChannel, type SlackEventsApiPayload } from "@flue/slack";
import { claimAndRun } from "./dedup.ts";
import type {
  ConversationLifecycleAgent,
  ConversationSurface,
} from "./retention.ts";

const DISABLED_SIGNING_SECRET = "0".repeat(64);
const LEADING_MENTION_RE = /^\s*<@[^>]+>/;

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

export interface SlackCoreEnv {
  Bindings: SlackCoreBindings;
}

export function routeSlackEvent(
  payload: SlackEventsApiPayload,
): RoutedSlackTurn | null {
  if (
    payload.type !== "event_callback" ||
    !payload.team_id ||
    !payload.api_app_id ||
    !payload.event_id
  ) {
    return null;
  }
  const event = payload.event;
  if (event.type === "app_mention") {
    const text = event.text?.replace(LEADING_MENTION_RE, "").trim();
    if (event.bot_id || event.bot_profile || !event.user || !text) return null;
    return {
      eventId: payload.event_id,
      teamId: payload.team_id,
      appId: payload.api_app_id,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      userId: event.user,
      text,
      surface: "channel",
    };
  }
  if (event.type !== "message") return null;
  if (event.subtype !== undefined || event.channel_type !== "im") return null;
  if (event.bot_id || event.bot_profile || !event.user || !event.text?.trim())
    return null;
  return {
    eventId: payload.event_id,
    teamId: payload.team_id,
    appId: payload.api_app_id,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    messageTs: event.ts,
    userId: event.user,
    text: event.text.trim(),
    surface: "private",
  };
}

export function missingReadiness(
  trusted: TrustedSlackConfig,
  bindings: Partial<SlackCoreBindings>,
): string[] {
  const missing: string[] = [];
  if (!trusted.signingSecret) missing.push("SLACK_SIGNING_SECRET");
  if (!trusted.botToken) missing.push("SLACK_BOT_TOKEN");
  if (!trusted.teamId) missing.push("SLACK_TEAM_ID");
  if (!trusted.appId) missing.push("SLACK_APP_ID");
  if (!bindings.DB) missing.push("DB");
  if (!bindings.FLUE_SLACK_AGENT_AGENT) missing.push("FLUE_SLACK_AGENT_AGENT");
  if (!bindings.AI) missing.push("AI");
  return missing;
}

export function createSlackIngress(
  trusted: TrustedSlackConfig,
  handleTurn: (
    turn: RoutedSlackTurn,
    instanceId: string,
    env: SlackCoreBindings,
  ) => Promise<void>,
) {
  const identityComplete = Boolean(
    trusted.signingSecret &&
      trusted.botToken &&
      trusted.teamId &&
      trusted.appId,
  );
  const channel = createSlackChannel<SlackCoreEnv>({
    signingSecret: identityComplete
      ? trusted.signingSecret
      : DISABLED_SIGNING_SECRET,
    events({ c, payload }) {
      if (!identityComplete) return;
      const turn = routeSlackEvent(payload);
      if (
        !turn ||
        turn.teamId !== trusted.teamId ||
        turn.appId !== trusted.appId
      )
        return;
      const instanceId = channel.instanceId({
        teamId: turn.teamId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
      });
      c.executionCtx.waitUntil(
        claimAndRun(c.env.DB, turn.eventId, () =>
          handleTurn(turn, instanceId, c.env),
        ).catch((error) => console.error("Slack event handling failed", error)),
      );
    },
  });
  return channel;
}
