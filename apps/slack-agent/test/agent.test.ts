import { expect, mock, test } from "bun:test";
import { composeInstructions, defineAgentConfig } from "@agentic-slack/core";
import type { ExpiryPayload, ExpirySchedule } from "@agentic-slack/core";

import config from "../agent.config.ts";
import { mockCloudflareWorkers } from "./module-mocks.ts";

// Snapshot the shipped values before the operator mock rebinds the config
// module: the runtime tests below must drive the agent with a distinct
// config, while these literals keep proving the shipped file is well-formed.
const shippedConfig = {
  description: config.description,
  model: config.model,
  name: config.name,
  ownerInstructions: config.ownerInstructions,
  retention: { ...config.retention },
};
const shippedPrompts = config.suggestedPrompts.map((prompt) => ({
  message: prompt.message,
  title: prompt.title,
}));

// Every field differs from both the shipped values in agent.config.ts and the
// defaults in packages/core/src/config.ts, so a runtime that ignores the
// operator config and falls back to either cannot satisfy the runtime tests.
const operatorConfig = defineAgentConfig({
  description: "Exercises operator configuration.",
  model: "cloudflare/@cf/test-operator-model",
  name: "Configured Agent",
  ownerInstructions: "Keep answers short.",
  retention: {
    channelDays: 9,
    privateDays: 3,
  },
});

const instructions: string[] = [];
let resolvedModel = "";

await mockCloudflareWorkers({
  SLACK_BOT_TOKEN: "xoxb-test-token",
});
const runtime = await import("@flue/runtime");
await mock.module("@flue/runtime", () => ({
  ...runtime,
  observe: () => () => {},
  useAgentFinish: () => {},
  useAgentStart: () => {},
  useInitialData: () => {},
  useInstruction: (instruction: string) => instructions.push(instruction),
  useModel: (model: string) => {
    resolvedModel = model;
  },
}));
// The spread keeps the mocked export list as wide as the real module: Bun
// freezes it on first use, so a narrow mock breaks whichever test file loads
// next and the breakage only shows up in one test-file order.
const cloudflare = await import("@flue/runtime/cloudflare");
await mock.module("@flue/runtime/cloudflare", () => ({
  ...cloudflare,
  extend: () => ({ base: undefined }),
}));
await mock.module("../agent.config.ts", () => ({ default: operatorConfig }));
const { SlackAgent, refreshConfiguredRetention } = await import(
  "../src/agent.ts"
);

test("ships four suggested prompts on the operator config", () => {
  expect(shippedPrompts).toEqual([
    {
      message:
        "Summarize this conversation and list the decisions and next steps.",
      title: "Summarize",
    },
    {
      message: "Draft a concise reply I can send in this thread.",
      title: "Draft a reply",
    },
    {
      message: "Explain the latest message in plain language.",
      title: "Explain",
    },
    {
      message: "Extract action items, owners, and due dates from this thread.",
      title: "Action items",
    },
  ]);
});

test("ships the pinned model, retention, and identity literals", () => {
  expect(shippedConfig.model).toBe("cloudflare/@cf/zai-org/glm-4.7-flash");
  expect(shippedConfig.retention).toEqual({ channelDays: 15, privateDays: 7 });
  expect(shippedConfig.name).toBe("Slack Agent");
  expect(shippedConfig.description).toBe(
    "A private, self-hosted assistant for Slack conversations.",
  );
  expect(shippedConfig.ownerInstructions).toBe(
    "Help the owner and their teammates with clear, accurate, concise answers.",
  );
});

test("uses the model and owner instructions from the operator config", () => {
  expect(SlackAgent({ id: "test" })).toBe(
    "Configured Agent: Exercises operator configuration.",
  );
  expect(resolvedModel).toBe("cloudflare/@cf/test-operator-model");
  expect(instructions).toEqual([...composeInstructions(operatorConfig)]);
});

test("schedules retention from the operator config days", async () => {
  const scheduled: { callback: string; seconds: number; surface: string }[] =
    [];
  const agent = {
    cancelSchedule() {
      return Promise.resolve(true);
    },
    destroy() {
      return Promise.resolve();
    },
    listSchedules() {
      return Promise.resolve([]);
    },
    schedule(
      seconds: number,
      callback: "expireConversation",
      payload: ExpiryPayload,
    ) {
      scheduled.push({ callback, seconds, surface: payload.surface });
      return Promise.resolve({
        callback,
        id: "new",
        payload,
        time: 1,
      } satisfies ExpirySchedule);
    },
  };
  await refreshConfiguredRetention(agent, "private");
  await refreshConfiguredRetention(agent, "channel");
  expect(scheduled).toEqual([
    {
      callback: "expireConversation",
      seconds: 3 * 86_400,
      surface: "private",
    },
    {
      callback: "expireConversation",
      seconds: 9 * 86_400,
      surface: "channel",
    },
  ]);
});
