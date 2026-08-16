import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_TRACING_CONTENT,
  refreshRetention,
} from "@agentic-slack/core";
import { dispatch, instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import * as v from "valibot";
import { SlackAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import type { WorkerBindings } from "./app.ts";

const slackResponse = v.object({
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
});

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

export default createApp(trusted, async (turn, instanceId, turnBindings) => {
  await refreshRetention(
    turnBindings.FLUE_SLACK_AGENT_AGENT,
    instanceId,
    turn.surface,
  );
  if (turn.surface === "channel") {
    const response = await fetch("https://slack.com/api/reactions.add", {
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
    const result = v.parse(slackResponse, await response.json());
    if (result.ok !== true) {
      throw new Error(
        `Slack reactions.add failed: ${result.error ?? response.status}`,
      );
    }
  }
  await dispatch(SlackAgent, {
    id: instanceId,
    idempotencyKey: turn.eventId,
    initialData: {
      channelId: turn.channelId,
      surface: turn.surface,
      teamId: turn.teamId,
      threadTs: turn.threadTs,
    },
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
});
