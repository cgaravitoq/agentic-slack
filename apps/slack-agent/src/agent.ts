"use agent";

import { env } from "cloudflare:workers";
import {
  composeInstructions,
  composeTools,
  expireLatest,
  MODEL,
  replaceRetention,
} from "@agentic-slack/core";
import type { ExpiryPayload, ExpirySchedule } from "@agentic-slack/core";
import { useInstruction, useModel, useTool } from "@flue/runtime";
import type { AgentProps } from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import config from "../agent.config.ts";

export const SlackAgent = (_props: AgentProps) => {
  useModel(MODEL);
  for (const instruction of composeInstructions(config)) {
    useInstruction(instruction);
  }
  const bindings = env;
  const runtimeContext = { bindings };
  for (const tool of composeTools(config, runtimeContext)) {
    useTool(tool);
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

export const cloudflare = extend<RetentionAgent>({
  base: (Base) =>
    class extends Base {
      async refreshRetention(surface: "private" | "channel"): Promise<void> {
        await replaceRetention(
          this,
          surface,
          config.retention.privateDays,
          config.retention.channelDays,
        );
      }

      async expireConversation(
        _payload: ExpiryPayload,
        schedule: ExpirySchedule,
      ): Promise<void> {
        await expireLatest(this, schedule);
      }
    },
});
