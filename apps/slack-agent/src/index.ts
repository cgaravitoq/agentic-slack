import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_TRACING_CONTENT,
  createSlackStream,
  refreshRetention,
  SLACK_DELIVERY_FALLBACK,
  SLACK_STREAM_FAILURE_NOTICE,
  streamTargetFor,
} from "@agentic-slack/core";
import { init, instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import * as v from "valibot";
import config from "../agent.config.ts";
import { SlackAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import type { WorkerBindings } from "./app.ts";
import { createLifecycleHandler } from "./lifecycle.ts";

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

export default createApp(
  trusted,
  async (turn, instanceId, turnBindings) => {
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
    const handle = init(SlackAgent, { id: instanceId });
    const receipt = await handle.dispatch({
      idempotencyKey: turn.eventId,
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
    // The stream is opened, fed and closed here so the destination stays bound
    // to the routed event and never to anything the model produced.
    const stream = createSlackStream(streamTargetFor(turn), trusted.botToken);
    try {
      const reply = await handle.read(receipt, {
        onEvent(chunk) {
          if (chunk.type === "message-delta" && chunk.kind === "text") {
            stream.append(chunk.delta);
          }
        },
      });
      await stream.finish(reply.text || SLACK_DELIVERY_FALLBACK);
    } catch (error: unknown) {
      await stream.fail(SLACK_STREAM_FAILURE_NOTICE);
      throw error;
    }
  },
  createLifecycleHandler(config, trusted.botToken),
);
