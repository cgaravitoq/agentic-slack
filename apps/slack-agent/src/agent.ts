"use agent";

import { env } from "cloudflare:workers";
import {
  composeInstructions,
  createReplyTool,
  expireLatest,
  MODEL,
  replaceRetention,
  type ExpiryPayload,
  type ExpirySchedule,
  type SlackDestination,
} from "@agentic-slack/core";
import {
  type AgentProps,
  useInitialData,
  useInstruction,
  useModel,
  useTool,
} from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import config from "../agent.config.ts";

const initialData = v.pipe(
  v.strictObject({
    teamId: v.string(),
    channelId: v.string(),
    threadTs: v.string(),
    surface: v.picklist(["private", "channel"]),
  }),
  v.readonly(),
);

export function SlackAgent(_props: AgentProps) {
  const data = v.parse(initialData, useInitialData<unknown>());
  const destination: SlackDestination = {
    channelId: data.channelId,
    threadTs: data.threadTs,
  };
  useModel(MODEL);
  for (const instruction of composeInstructions(config))
    useInstruction(instruction);
  const bindings = env as unknown as { SLACK_BOT_TOKEN: string };
  useTool(createReplyTool(destination, bindings.SLACK_BOT_TOKEN));
  return `${config.name}: ${config.description}`;
}

SlackAgent.initialData = initialData;

interface RetentionAgent {
  listSchedules(): Promise<readonly ExpirySchedule[]>;
  cancelSchedule(id: string): Promise<boolean>;
  schedule(
    delaySeconds: number,
    callback: "expireConversation",
    payload: ExpiryPayload,
  ): Promise<ExpirySchedule>;
  destroy(): Promise<void>;
}

export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async refreshRetention(surface: "private" | "channel"): Promise<void> {
        await replaceRetention(
          this as unknown as RetentionAgent,
          surface,
          config.retention.privateDays,
          config.retention.channelDays,
        );
      }

      async expireConversation(
        _payload: ExpiryPayload,
        schedule: ExpirySchedule,
      ): Promise<void> {
        await expireLatest(this as unknown as RetentionAgent, schedule);
      }
    },
});
