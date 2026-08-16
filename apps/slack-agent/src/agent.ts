"use agent";

import { env } from "cloudflare:workers";
import {
  composeInstructions,
  composeTools,
  CORE_REPLY_TOOL_NAME,
  createReplyTool,
  expireLatest,
  extractAssistantText,
  MODEL,
  replaceRetention,
  SLACK_DELIVERY_FALLBACK,
} from "@agentic-slack/core";
import type {
  ExpiryPayload,
  ExpirySchedule,
  SlackDestination,
} from "@agentic-slack/core";
import {
  observe,
  useAgentFinish,
  useInitialData,
  useInstruction,
  useModel,
  useTool,
} from "@flue/runtime";
import type { AgentProps } from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import config from "../agent.config.ts";

let lastAssistantText = "";

// Module scope: this file runs in the Durable Object isolate that dispatches
// agent turns, so turn events are observable here but never in the Worker.
observe((event) => {
  if (event.type === "turn" && event.purpose === "agent" && !event.isError) {
    const text = extractAssistantText(event.response?.output?.content);
    if (text) {
      lastAssistantText = text;
    }
  }
});

const initialData = v.pipe(
  v.strictObject({
    channelId: v.string(),
    surface: v.picklist(["private", "channel"]),
    teamId: v.string(),
    threadTs: v.string(),
  }),
  v.readonly(),
);

type WorkerEnv = typeof env;

const hasBotToken = (
  value: WorkerEnv,
): value is { SLACK_BOT_TOKEN: string } => {
  const entry = Object.entries(value).find(
    ([key]) => key === "SLACK_BOT_TOKEN",
  );
  return typeof entry?.[1] === "string";
};

export const SlackAgent = (_props: AgentProps) => {
  const data = v.parse(initialData, useInitialData());
  const destination: SlackDestination = {
    channelId: data.channelId,
    threadTs: data.threadTs,
  };
  useModel(MODEL);
  for (const instruction of composeInstructions(config)) {
    useInstruction(instruction);
  }
  if (!hasBotToken(env)) {
    throw new Error("Missing SLACK_BOT_TOKEN binding");
  }
  const bindings = env;
  const runtimeContext = { bindings };
  const reply = createReplyTool(destination, bindings.SLACK_BOT_TOKEN);
  for (const tool of composeTools(config, runtimeContext, reply)) {
    useTool(tool);
  }
  useAgentFinish(async (ctx) => {
    const text = lastAssistantText;
    lastAssistantText = "";
    if (
      ctx.response.toolCalls.some(
        (call) => call.tool === CORE_REPLY_TOOL_NAME && !call.isError,
      )
    ) {
      return;
    }
    await reply.run({
      data: { text: text || SLACK_DELIVERY_FALLBACK },
      log: ctx.log,
      toolCallId: "finish-fallback",
    });
  });
  return `${config.name}: ${config.description}`;
};

SlackAgent.initialData = initialData;

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
