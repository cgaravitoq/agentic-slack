import {
  createSlackIngress,
  missingReadiness,
  workerSecretValue,
} from "@agentic-slack/core";
import type {
  Delegation,
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
  delegation?: Delegation,
  delegationSecrets: readonly string[] = [],
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
    for (const name of delegationSecrets) {
      if ((workerSecretValue(context.env, name) ?? "") === "") {
        missing.push(name);
      }
    }
    return missing.length === 0
      ? context.json({ status: "ready" })
      : context.json({ missing, status: "not_ready" }, 503);
  });
  if (progress !== undefined) {
    app.post(
      "/progress",
      async (context) => await progress.handle(context.req.raw),
    );
    app.get(
      "/progress/channels",
      async (context) => await progress.handleChannels(context.req.raw),
    );
    app.get(
      "/progress/replies",
      async (context) => await progress.handleReplies(context.req.raw),
    );
  }
  if (delegation !== undefined) {
    app.all(
      "/delegation/*",
      async (context) => await delegation.handle(context.req.raw),
    );
  }
  app.route("/channels/slack", channel.route());
  return app;
};
