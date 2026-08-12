import {
  createSlackIngress,
  missingReadiness,
  type RoutedSlackTurn,
  type SlackCoreBindings,
  type TrustedSlackConfig,
} from "@agentic-slack/core";
import { Hono } from "hono";

export interface WorkerBindings extends SlackCoreBindings {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_TEAM_ID: string;
  SLACK_APP_ID: string;
}

export interface WorkerEnv {
  Bindings: WorkerBindings;
}

export function createApp(
  trusted: TrustedSlackConfig,
  handleTurn: (
    turn: RoutedSlackTurn,
    instanceId: string,
    bindings: SlackCoreBindings,
  ) => Promise<void>,
) {
  const channel = createSlackIngress(trusted, handleTurn);
  const app = new Hono<WorkerEnv>();
  app.get("/health", (context) => {
    const missing = missingReadiness(trusted, context.env);
    return missing.length === 0
      ? context.json({ status: "ready" })
      : context.json({ status: "not_ready", missing }, 503);
  });
  app.route("/channels/slack", channel.route());
  return app;
}
