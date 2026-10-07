import { env, waitUntil } from "cloudflare:workers";
import {
  CLOUDFLARE_TRACING_CONTENT,
  createSlackProgressEndpoint,
  refreshRetention,
  requiresApproval,
  slackDeliveryBinding,
  streamTargetFor,
  workerSecretValue,
} from "@agentic-slack/core";
import type { SlackProgressTurn } from "@agentic-slack/core";
import { init, instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import config from "../agent.config.ts";
import { SlackAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import type { WorkerBindings } from "./app.ts";
import { createApprovalHandler } from "./approval.ts";
import { createLifecycleHandler } from "./lifecycle.ts";
import { createMembershipHandler } from "./membership.ts";
import { selectProvider } from "./provider.ts";

const bindings: WorkerBindings = env;
const trusted = {
  allowedUserIds: config.allowedUserIds,
  appId: bindings.SLACK_APP_ID,
  botToken: bindings.SLACK_BOT_TOKEN,
  signingSecret: bindings.SLACK_SIGNING_SECRET,
  teamId: bindings.SLACK_TEAM_ID,
};

export const narrateProgressTurn = async (
  turn: SlackProgressTurn,
): Promise<void> => {
  await refreshRetention(
    bindings.FLUE_SLACK_AGENT_AGENT,
    turn.instanceId,
    "channel",
  );
  await init(SlackAgent, { id: turn.instanceId }).dispatch({
    idempotencyKey: `progress:${turn.milestoneId}`,
    message: {
      attributes: turn.binding,
      body: turn.body,
      kind: "signal",
      type: "slack.progress",
    },
  });
};

const progress =
  config.progress === undefined
    ? undefined
    : createSlackProgressEndpoint(config.progress, {
        bearer: workerSecretValue(bindings, config.progress.authSecret) ?? "",
        db: bindings.DB,
        narrate: narrateProgressTurn,
        teamId: trusted.teamId,
        token: trusted.botToken,
      });

instrument(createCloudflareTracing({ content: CLOUDFLARE_TRACING_CONTENT }));
setProvider(selectProvider(config.modelProvider, bindings));

// The Workers runtime calls this default export; no repo code imports it.
/** @public */
export default createApp(
  trusted,
  config.modelProvider,
  async (turn, instanceId, turnBindings) => {
    await refreshRetention(
      turnBindings.FLUE_SLACK_AGENT_AGENT,
      instanceId,
      turn.surface,
    );
    if (turn.surface === "channel") {
      const reaction = fetch("https://slack.com/api/reactions.add", {
        body: JSON.stringify({
          channel: turn.channelId,
          name: "eyes",
          timestamp: turn.messageTs,
        }),
        headers: {
          authorization: `Bearer ${trusted.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        method: "POST",
      });
      // The ingress answers Slack as soon as the dispatch resolves, and the
      // runtime cancels a subrequest still in flight after the response.
      // oxlint-disable-next-line promise/prefer-await-to-then
      waitUntil(reaction.catch(() => null));
    }
    const handle = init(SlackAgent, { id: instanceId });
    await handle.dispatch({
      idempotencyKey: turn.eventId,
      message: {
        attributes: {
          ...slackDeliveryBinding(streamTargetFor(turn)),
          event_id: turn.eventId,
          message_ts: turn.messageTs,
          user: turn.userId,
        },
        body: turn.text,
        kind: "signal",
        type:
          turn.surface === "private" ? "slack.message.im" : "slack.app_mention",
      },
    });
  },
  createLifecycleHandler(config, trusted.botToken),
  requiresApproval(config)
    ? createApprovalHandler(trusted.botToken)
    : undefined,
  createMembershipHandler(config, trusted.botToken),
  progress,
);
