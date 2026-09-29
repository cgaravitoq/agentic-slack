"use agent";

import { env } from "cloudflare:workers";
import {
  applySlackDeliveryEvent,
  composeInstructions,
  createSqlSlackDeliveryStore,
  expireLatest,
  failSlackDelivery,
  finishSlackDelivery,
  openSlackDelivery,
  replaceRetention,
  slackDeliveryBindingSchema,
  slackEventFromObservation,
} from "@agentic-slack/core";
import type {
  ExpiryPayload,
  ExpirySchedule,
  SlackDeliveryBinding,
  SlackDeliveryStore,
} from "@agentic-slack/core";
import {
  observe,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useInstruction,
  useMcpConnection,
  useModel,
  useSkill,
} from "@flue/runtime";
import type {
  AgentProps,
  FlueObservation,
  McpConnectionDefinition,
} from "@flue/runtime";
import { extend, getCloudflareContext } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import config from "../agent.config.ts";

// Rebuilding the store re-runs its CREATE TABLE on every observation, and one
// isolate can host several Durable Objects, so the cache is keyed by storage.
const deliveryStores = new WeakMap<object, SlackDeliveryStore>();

const deliveryStore = (): SlackDeliveryStore => {
  const { sql } = getCloudflareContext().storage;
  const cached = deliveryStores.get(sql);
  if (cached !== undefined) {
    return cached;
  }
  const store = createSqlSlackDeliveryStore(sql);
  deliveryStores.set(sql, store);
  return store;
};

const botToken = (): string => env.SLACK_BOT_TOKEN;

const workerSecret = (name: string): string =>
  v.parse(v.object({ [name]: v.pipe(v.string(), v.nonEmpty()) }), env)[name];

export const startSlackTurnDelivery = (
  instanceId: string,
  binding: SlackDeliveryBinding,
): Promise<void> =>
  openSlackDelivery(deliveryStore(), instanceId, binding, botToken());

export const observeSlackTurnDelivery = (
  event: FlueObservation,
): void | Promise<void> => {
  const instanceId = event.instanceId ?? "";
  const mapped = slackEventFromObservation(event);
  if (mapped === "fail") {
    return failSlackDelivery(deliveryStore(), instanceId, botToken());
  }
  if (mapped !== undefined) {
    applySlackDeliveryEvent(deliveryStore(), instanceId, mapped);
  }
};

export const finishSlackTurnDelivery = (instanceId: string): Promise<void> =>
  finishSlackDelivery(deliveryStore(), instanceId, botToken());

observe(observeSlackTurnDelivery);

export const SlackAgent = (props: AgentProps) => {
  useModel(config.model);
  for (const instruction of composeInstructions(config)) {
    useInstruction(instruction);
  }
  for (const skill of config.skills) {
    useSkill(skill);
  }
  for (const { authSecret, ...server } of config.mcpServers) {
    const connection: McpConnectionDefinition = { ...server };
    if (authSecret !== undefined) {
      connection.auth = () => workerSecret(authSecret);
    }
    useMcpConnection(connection);
  }
  const delivery = useDelivery();
  useAgentStart(async () => {
    if (delivery.kind !== "signal") {
      return;
    }
    await startSlackTurnDelivery(
      props.id,
      v.parse(slackDeliveryBindingSchema, delivery.attributes),
    );
  });
  useAgentFinish(async () => {
    await finishSlackTurnDelivery(props.id);
  });
  return `${config.name}: ${config.description}`;
};

interface RetentionAgent {
  listSchedules: () => Promise<readonly ExpirySchedule[]>;
  cancelSchedule: (id: string) => Promise<boolean>;
  schedule: (
    delaySeconds: number,
    callback: "expireConversation",
    payload: ExpiryPayload,
  ) => Promise<ExpirySchedule>;
  destroy: () => Promise<void>;
}

const refreshConfiguredRetention = (
  agent: RetentionAgent,
  surface: "private" | "channel",
): Promise<void> =>
  replaceRetention(
    agent,
    surface,
    config.retention.privateDays,
    config.retention.channelDays,
  );

// The Flue runtime imports this export by name; no repo code does.
/** @public */
export const cloudflare = extend<RetentionAgent>({
  base: (Base) =>
    class extends Base {
      async refreshRetention(surface: "private" | "channel"): Promise<void> {
        await refreshConfiguredRetention(this, surface);
      }

      async expireConversation(
        _payload: ExpiryPayload,
        schedule: ExpirySchedule,
      ): Promise<void> {
        await expireLatest(this, schedule);
      }
    },
});
