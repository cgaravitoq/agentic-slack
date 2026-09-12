import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_TRACING_CONTENT,
  refreshRetention,
  slackDeliveryBinding,
  streamTargetFor,
} from "@agentic-slack/core";
import { init, instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import config from "../agent.config.ts";
import { SlackAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import type { WorkerBindings } from "./app.ts";
import { createLifecycleHandler } from "./lifecycle.ts";

const bindings: WorkerBindings = env;
const trusted = {
  appId: bindings.SLACK_APP_ID,
  botToken: bindings.SLACK_BOT_TOKEN,
  signingSecret: bindings.SLACK_SIGNING_SECRET,
  teamId: bindings.SLACK_TEAM_ID,
};

instrument(createCloudflareTracing({ content: CLOUDFLARE_TRACING_CONTENT }));
setProvider(
  cloudflareBindingProvider({ binding: bindings.AI, gateway: false }),
);

// The Workers runtime calls this default export; no repo code imports it.
/** @public */
export default createApp(
  trusted,
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
      // oxlint-disable-next-line promise/prefer-await-to-then
      void reaction.catch(() => null);
    }
    const handle = init(SlackAgent, { id: instanceId });
    await handle.dispatch({
      idempotencyKey: turn.eventId,
      initialData: slackDeliveryBinding(streamTargetFor(turn)),
      message: {
        attributes: {
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
);
