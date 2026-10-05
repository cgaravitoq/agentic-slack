import { createSlackIngress, missingReadiness } from "@agentic-slack/core";
import type {
  ModelProvider,
  RoutedSlackLifecycle,
  RoutedSlackMembership,
  RoutedSlackTurn,
  SlackBlockActionsPayload,
  SlackCoreBindings,
  SlackProgressEndpoint,
  TrustedSlackConfig,
} from "@agentic-slack/core";
import { Hono } from "hono";

export type WorkerBindings = Cloudflare.Env;

export interface WorkerEnv {
  Bindings: WorkerBindings;
}

export const createApp = (
  trusted: TrustedSlackConfig,
  modelProvider: ModelProvider,
  handleTurn: (
    turn: RoutedSlackTurn,
    instanceId: string,
    bindings: SlackCoreBindings,
  ) => Promise<void>,
  handleLifecycle?: (
    lifecycle: RoutedSlackLifecycle,
    bindings: SlackCoreBindings,
  ) => Promise<void> | void,
  handleInteraction?: (
    payload: SlackBlockActionsPayload,
    bindings: SlackCoreBindings,
  ) => Promise<void>,
  handleMembership?: (
    membership: RoutedSlackMembership,
    bindings: SlackCoreBindings,
  ) => Promise<void> | void,
  progress?: SlackProgressEndpoint,
) => {
  const channel = createSlackIngress(
    trusted,
    handleTurn,
    handleLifecycle,
    handleInteraction,
    handleMembership,
  );
  const app = new Hono<WorkerEnv>();
  app.get("/health", (context) => {
    const missing = missingReadiness(
      trusted,
      context.env,
      modelProvider,
      progress?.authSecret,
    );
    return missing.length === 0
      ? context.json({ status: "ready" })
      : context.json({ missing, status: "not_ready" }, 503);
  });
  if (progress !== undefined) {
    app.post(
      "/progress",
      async (context) => await progress.handle(context.req.raw),
    );
  }
  app.route("/channels/slack", channel.route());
  return app;
};
