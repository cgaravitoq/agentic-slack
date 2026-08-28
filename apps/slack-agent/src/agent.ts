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
  useInitialData,
  useInstruction,
  useModel,
} from "@flue/runtime";
import type { AgentProps, FlueObservation } from "@flue/runtime";
import { extend, getCloudflareContext } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import config from "../agent.config.ts";

const deliveryStore = (): SlackDeliveryStore =>
  createSqlSlackDeliveryStore(getCloudflareContext().storage.sql);

const botToken = (): string => env.SLACK_BOT_TOKEN;

export const startSlackTurnDelivery = (
  instanceId: string,
  binding: SlackDeliveryBinding,
): void => {
  openSlackDelivery(deliveryStore(), instanceId, binding, botToken());
};

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
  const bound = useInitialData<SlackDeliveryBinding | undefined>();
  useAgentStart(() => {
    if (bound === undefined) {
      return;
    }
    startSlackTurnDelivery(
      props.id,
      v.parse(slackDeliveryBindingSchema, bound),
    );
  });
  useAgentFinish(async () => {
    await finishSlackTurnDelivery(props.id);
  });
  return `${config.name}: ${config.description}`;
};
SlackAgent.initialData = slackDeliveryBindingSchema;

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

export const refreshConfiguredRetention = (
  agent: RetentionAgent,
  surface: "private" | "channel",
): Promise<void> =>
  replaceRetention(
    agent,
    surface,
    config.retention.privateDays,
    config.retention.channelDays,
  );

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
