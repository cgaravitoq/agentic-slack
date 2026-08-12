import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_TRACING_CONTENT,
  refreshRetention,
} from "@agentic-slack/core";
import { dispatch, instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import { SlackAgent } from "./agent.ts";
import { createApp, type WorkerBindings } from "./app.ts";

const bindings = env as unknown as WorkerBindings;
const trusted = {
  signingSecret: bindings.SLACK_SIGNING_SECRET,
  botToken: bindings.SLACK_BOT_TOKEN,
  teamId: bindings.SLACK_TEAM_ID,
  appId: bindings.SLACK_APP_ID,
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
      method: "POST",
      headers: {
        authorization: `Bearer ${trusted.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: turn.channelId,
        timestamp: turn.messageTs,
        name: "eyes",
      }),
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
    };
    if (!result.ok)
      throw new Error(
        `Slack reactions.add failed: ${result.error ?? response.status}`,
      );
  }
  await dispatch(SlackAgent, {
    id: instanceId,
    idempotencyKey: turn.eventId,
    initialData: {
      teamId: turn.teamId,
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      surface: turn.surface,
    },
    message: {
      kind: "signal",
      type:
        turn.surface === "private" ? "slack.message.im" : "slack.app_mention",
      body: turn.text,
      attributes: {
        user: turn.userId,
        event_id: turn.eventId,
        message_ts: turn.messageTs,
      },
    },
  });
});
