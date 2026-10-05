import { createSlackChannel } from "@flue/slack";
import type {
  SlackBlockActionsPayload,
  SlackEvent,
  SlackEventCallbackPayload,
  SlackEventsApiPayload,
} from "@flue/slack";
import { MODEL_PROVIDER_CLOUDFLARE } from "./config.ts";
import type { ModelProvider } from "./config.ts";
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

export interface ModelBrokerBinding {
  fetch: (request: Request) => Promise<Response>;
}

export interface SlackCoreBindings {
  DB: D1Database;
  FLUE_SLACK_AGENT_AGENT: DurableObjectNamespace<ConversationLifecycleAgent>;
  AI: Ai;
  MODEL_BROKER: ModelBrokerBinding;
}

export interface TrustedSlackConfig {
  signingSecret: string;
  botToken: string;
  teamId: string;
  appId: string;
  allowedUserIds?: readonly string[];
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
  userId: string;
}

export interface RoutedSlackMembership {
  kind: "membership";
  eventId: string;
  teamId: string;
  appId: string;
  channelId: string;
  userId: string;
  inviterId: string;
}

export type RoutedSlackEvent =
  | RoutedSlackTurn
  | RoutedSlackLifecycle
  | RoutedSlackMembership;

const conversationInstanceRef = (turn: RoutedSlackTurn) => ({
  channelId: turn.channelId,
  teamId: turn.teamId,
  threadTs: turn.surface === "private" ? turn.channelId : turn.threadTs,
});

export interface SlackCoreEnv {
  Bindings: SlackCoreBindings;
}

interface SlackMessageEvent {
  readonly bot_id?: string;
  readonly bot_profile?: unknown;
  readonly channel: string;
  readonly text?: string;
  readonly thread_ts?: string;
  readonly ts: string;
  readonly user?: string;
}

const mentionTurn = (
  payload: SlackEventCallbackPayload,
  event: Extract<SlackEvent, { type: "app_mention" }>,
): RoutedSlackTurn | null => {
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
};

const directMessageTurn = (
  payload: SlackEventCallbackPayload,
  event: SlackMessageEvent,
): RoutedSlackTurn | null => {
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

const routeSlackEvent = (
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
      userId: event.assistant_thread.user_id,
    };
  }
  if (event.type === "member_joined_channel") {
    const { user } = event;
    if (user === undefined || user === "") {
      return null;
    }
    return {
      appId: payload.api_app_id,
      channelId: event.channel,
      eventId: payload.event_id,
      inviterId: event.inviter ?? "",
      kind: "membership",
      teamId: payload.team_id,
      userId: user,
    };
  }
  if (event.type === "app_mention") {
    return mentionTurn(payload, event);
  }
  if (event.type !== "message") {
    return null;
  }
  if (event.subtype !== undefined || event.channel_type !== "im") {
    return null;
  }
  return directMessageTurn(payload, event);
};

const ack = (status: number): Response => new Response(null, { status });

const claimThenAcknowledge = async (
  db: D1Database,
  eventId: string,
  run: () => Promise<void> | void,
): Promise<Response> => {
  try {
    await claimAndRun(db, eventId, run);
    return ack(200);
  } catch (error: unknown) {
    console.error("Slack event handling failed", error);
    return ack(500);
  }
};

export const missingReadiness = (
  trusted: TrustedSlackConfig,
  bindings: Partial<SlackCoreBindings>,
  modelProvider: ModelProvider,
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
  if (modelProvider === MODEL_PROVIDER_CLOUDFLARE) {
    if (!bindings.AI) {
      missing.push("AI");
    }
  } else if (!bindings.MODEL_BROKER) {
    missing.push("MODEL_BROKER");
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
  ) => Promise<void> | void,
  handleInteraction?: (
    payload: SlackBlockActionsPayload,
    env: SlackCoreBindings,
  ) => Promise<void>,
  handleMembership?: (
    membership: RoutedSlackMembership,
    env: SlackCoreBindings,
  ) => Promise<void> | void,
) => {
  const identityComplete = Boolean(
    trusted.signingSecret &&
      trusted.botToken &&
      trusted.teamId &&
      trusted.appId,
  );
  const allowedUserIds = trusted.allowedUserIds ?? [];
  // `createSlackChannel` mounts `/interactions` only for a handler it is given,
  // so a deployment with no decision handler exposes no endpoint whose only
  // answer is 200.
  const channel = createSlackChannel<SlackCoreEnv>({
    async events({ c, payload }): Promise<Response> {
      if (!identityComplete) {
        return ack(200);
      }
      const routed = routeSlackEvent(payload);
      if (
        !routed ||
        routed.teamId !== trusted.teamId ||
        routed.appId !== trusted.appId
      ) {
        return ack(200);
      }
      // A refused user is answered like a foreign workspace: before the claim,
      // so no row, reaction, reply or model call can ever follow the event. A
      // membership event names the member that joined rather than the inviter
      // it is judged by, so its decision belongs to the membership handler.
      if (
        routed.kind !== "membership" &&
        allowedUserIds.length > 0 &&
        !allowedUserIds.includes(routed.userId)
      ) {
        return ack(200);
      }
      const claim = (work: () => Promise<void> | void): Promise<Response> =>
        claimThenAcknowledge(c.env.DB, routed.eventId, work);
      if (routed.kind === "turn") {
        return await claim(() =>
          handleTurn(
            routed,
            channel.instanceId(conversationInstanceRef(routed)),
            c.env,
          ),
        );
      }
      if (routed.kind === "membership") {
        return handleMembership === undefined
          ? ack(200)
          : await claim(() => handleMembership(routed, c.env));
      }
      return handleLifecycle === undefined
        ? ack(200)
        : await claim(() => handleLifecycle(routed, c.env));
    },
    interactions:
      handleInteraction === undefined
        ? undefined
        : async ({ c, payload }): Promise<Response> => {
            if (
              !identityComplete ||
              payload.type !== "block_actions" ||
              payload.team?.id !== trusted.teamId ||
              payload.api_app_id !== trusted.appId
            ) {
              return ack(200);
            }
            try {
              await handleInteraction(payload, c.env);
              return ack(200);
            } catch (error: unknown) {
              console.error("Slack interaction handling failed", error);
              return ack(500);
            }
          },
    signingSecret: identityComplete
      ? trusted.signingSecret
      : DISABLED_SIGNING_SECRET,
  });
  return channel;
};
