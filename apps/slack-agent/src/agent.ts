"use agent";

import {
  composeInstructions,
  expireLatest,
  replaceRetention,
} from "@agentic-slack/core";
import type { ExpiryPayload, ExpirySchedule } from "@agentic-slack/core";
import { useInstruction, useModel } from "@flue/runtime";
import type { AgentProps } from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import config from "../agent.config.ts";

export const SlackAgent = (_props: AgentProps) => {
  useModel(config.model);
  for (const instruction of composeInstructions(config)) {
    useInstruction(instruction);
  }
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
