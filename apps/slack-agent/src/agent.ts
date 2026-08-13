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
  type ResolvedAgentConfig,
  type ExpiryPayload,
  type ExpirySchedule,
  type SlackDestination,
} from "@agentic-slack/core";
import {
  type AgentProps,
  observe,
  useAgentFinish,
  useInitialData,
  useInstruction,
  useModel,
  useTool,
} from "@flue/runtime";
import { extend } from "@flue/runtime/cloudflare";
import * as v from "valibot";
import config from "../agent.config.ts";
import type { WorkerBindings } from "./app.ts";

let lastAssistantText = "";

// Module scope: this file runs in the Durable Object isolate that dispatches
// agent turns, so turn events are observable here but never in the Worker.
observe((event) => {
  if (event.type === "turn" && event.purpose === "agent" && !event.isError) {
    const text = extractAssistantText(event.response?.output?.content);
    if (text) lastAssistantText = text;
  }
});

type RuntimeContext =
  typeof config extends ResolvedAgentConfig<infer Context> ? Context : never;

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
  const bindings = env as unknown as WorkerBindings;
  const runtimeContext = { bindings } as unknown as RuntimeContext;
  const reply = createReplyTool(destination, bindings.SLACK_BOT_TOKEN);
  for (const tool of composeTools(config, runtimeContext, reply)) useTool(tool);
  useAgentFinish(async (ctx) => {
    const text = lastAssistantText;
    lastAssistantText = "";
    if (
      ctx.response.toolCalls.some(
        (call) => call.tool === CORE_REPLY_TOOL_NAME && !call.isError,
      )
    )
      return;
    await reply.run({
      data: { text: text || SLACK_DELIVERY_FALLBACK },
    } as Parameters<typeof reply.run>[0]);
  });
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
