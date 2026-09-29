import { expect, mock, test } from "bun:test";
import { defineSkill } from "@flue/runtime";
import type {
  DeliveredMessage,
  McpConnectionDefinition,
  Skill,
} from "@flue/runtime";
import * as v from "valibot";
import { composeInstructions, defineAgentConfig } from "@agentic-slack/core";
import type { ExpiryPayload, ExpirySchedule } from "@agentic-slack/core";
import { evictLiveSlackDelivery } from "../../../packages/core/src/delivery.ts";

import config from "../agent.config.ts";
import type { CapturedCloudflareExtension } from "./module-mocks.ts";
import {
  mockCloudflareWorkers,
  retentionExtendCapture,
} from "./module-mocks.ts";

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
const shippedMcpServers = [...config.mcpServers];
const shippedSkills = [...config.skills];

// Every field differs from both the shipped values in agent.config.ts and the
// defaults in packages/core/src/config.ts, so a runtime that ignores the
// operator config and falls back to either cannot satisfy the runtime tests.
const refunds = defineSkill({
  description:
    "Process a customer refund request. Use when a customer disputes a charge.",
  instructions: "Confirm the order ID, then issue the refund.",
  name: "refunds",
});
const operatorConfig = defineAgentConfig({
  description: "Exercises operator configuration.",
  mcpServers: [
    {
      authSecret: "CRM_MCP_TOKEN",
      name: "crm",
      requireApproval: ["create_organization"],
      tools: ["create_organization"],
      url: "https://mcp.example.test/mcp",
    },
    { name: "docs", optional: true, url: "https://docs.example.test/mcp" },
  ],
  model: "cloudflare/@cf/test-operator-model",
  name: "Configured Agent",
  ownerInstructions: "Keep answers short.",
  retention: {
    channelDays: 9,
    privateDays: 3,
  },
  skills: [refunds],
});

class RecordingAgent {
  cancels: string[] = [];
  destroyed = 0;
  listed: ExpirySchedule[] = [];
  scheduled: {
    callback: "expireConversation";
    payload: ExpiryPayload;
    seconds: number;
  }[] = [];

  cancelSchedule(id: string) {
    this.cancels.push(id);
    return Promise.resolve(true);
  }

  destroy() {
    this.destroyed += 1;
    return Promise.resolve();
  }

  listSchedules() {
    return Promise.resolve(this.listed);
  }

  schedule(
    seconds: number,
    callback: "expireConversation",
    payload: ExpiryPayload,
  ) {
    this.scheduled.push({ callback, payload, seconds });
    return Promise.resolve({
      callback,
      id: `sched-${String(this.scheduled.length)}`,
      payload,
      time: this.scheduled.length,
    } satisfies ExpirySchedule);
  }
}

interface WiredRetentionAgent extends RecordingAgent {
  expireConversation: (
    payload: ExpiryPayload,
    schedule: ExpirySchedule,
  ) => Promise<void>;
  refreshRetention: (surface: "private" | "channel") => Promise<void>;
}

const instructions: string[] = [];
const mcpConnections: McpConnectionDefinition[] = [];
const mountedSkills: Skill[] = [];
let resolvedModel = "";
const userMessage: DeliveredMessage = { body: "", kind: "user" };
let delivery: DeliveredMessage = userMessage;
const agentStarts: (() => void)[] = [];
const deliveryRows = new Map<string, string>();
const deliverySql = {
  exec(query: string, ...bindings: unknown[]) {
    if (query.trimStart().startsWith("SELECT")) {
      const payload = deliveryRows.get(String(bindings[0]));
      return { toArray: () => (payload === undefined ? [] : [{ payload }]) };
    }
    if (query.trimStart().startsWith("INSERT")) {
      deliveryRows.set(String(bindings[0]), String(bindings[1]));
    }
    return { toArray: () => [] };
  },
};

const workerEnv = {
  CRM_MCP_TOKEN: "crm-test-token",
  SLACK_BOT_TOKEN: "xoxb-test-token",
};
await mockCloudflareWorkers(workerEnv);
const runtime = await import("@flue/runtime");
await mock.module("@flue/runtime", () => ({
  ...runtime,
  observe: () => () => {},
  useAgentFinish: () => {},
  useAgentStart: (start: () => void) => agentStarts.push(start),
  useDelivery: () => delivery,
  useInstruction: (instruction: string) => instructions.push(instruction),
  useMcpConnection: (definition: McpConnectionDefinition) =>
    mcpConnections.push(definition),
  useModel: (model: string) => {
    resolvedModel = model;
  },
  useSkill: (skill: Skill) => mountedSkills.push(skill),
}));
// The spread keeps the mocked export list as wide as the real module: Bun
// freezes it on first use, so a narrow mock breaks whichever test file loads
// next and the breakage only shows up in one test-file order.
const cloudflare = await import("@flue/runtime/cloudflare");
await mock.module("@flue/runtime/cloudflare", () => ({
  ...cloudflare,
  extend: (extension: CapturedCloudflareExtension) => {
    retentionExtendCapture.extension = extension;
    return extension;
  },
  getCloudflareContext: () => ({ storage: { sql: deliverySql } }),
}));
await mock.module("../agent.config.ts", () => ({ default: operatorConfig }));
const { SlackAgent } = await import("../src/agent.ts");

const createRetentionAgent = (): WiredRetentionAgent => {
  const factory = retentionExtendCapture.extension?.base;
  if (factory === undefined) {
    throw new Error("cloudflare.base was not registered");
  }
  return new (factory(RecordingAgent))();
};

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

test("ships no MCP servers and no skills", () => {
  expect(shippedMcpServers).toEqual([]);
  expect(shippedSkills).toEqual([]);
});

test("uses the model and owner instructions from the operator config", () => {
  expect(SlackAgent({ id: "test" })).toBe(
    "Configured Agent: Exercises operator configuration.",
  );
  expect(resolvedModel).toBe("cloudflare/@cf/test-operator-model");
  expect(instructions).toEqual([...composeInstructions(operatorConfig)]);
});

test("mounts each configured MCP server with its bearer read from the Worker secret", async () => {
  mcpConnections.length = 0;
  SlackAgent({ id: "test" });
  const [crm, docs] = mcpConnections;
  expect(mcpConnections).toHaveLength(2);
  expect(crm).toMatchObject({
    name: "crm",
    tools: ["create_organization"],
    url: "https://mcp.example.test/mcp",
  });
  const auth = v.parse(v.function(), crm?.auth);
  expect(await auth()).toBe("crm-test-token");
  workerEnv.CRM_MCP_TOKEN = "crm-rotated-token";
  expect(await auth()).toBe("crm-rotated-token");
  workerEnv.CRM_MCP_TOKEN = "crm-test-token";
  expect(docs).toEqual({
    name: "docs",
    optional: true,
    url: "https://docs.example.test/mcp",
  });
});

test("gates only the server whose tools require approval", () => {
  mcpConnections.length = 0;
  SlackAgent({ id: "test" });
  const [crm, docs] = mcpConnections;
  expect(v.is(v.function(), crm?.fetch)).toBe(true);
  expect(Object.hasOwn(docs ?? {}, "fetch")).toBe(false);
});

test("mounts each configured skill with its name and instructions", () => {
  mountedSkills.length = 0;
  SlackAgent({ id: "test" });
  expect(mountedSkills).toEqual([refunds]);
});

const directMessage = (threadTs: string): DeliveredMessage => ({
  attributes: {
    channelId: "D777",
    event_id: `Ev-${threadTs}`,
    message_ts: threadTs,
    recipientTeamId: "T123",
    recipientUserId: "U777",
    surface: "private",
    threadTs,
    user: "U777",
  },
  body: threadTs,
  kind: "signal",
  type: "slack.message.im",
});

test("streams each dispatched message's reply to the thread named in its attributes", () => {
  const instanceId = "slack:v1:T123:D777:D777";
  const startWith = (message: DeliveredMessage) => {
    delivery = message;
    agentStarts.length = 0;
    SlackAgent({ id: instanceId });
    for (const start of agentStarts) {
      start();
    }
  };
  const recordThreads = () => {
    const payload = deliveryRows.get(instanceId);
    const record = v.parse(
      v.object({
        binding: v.object({ threadTs: v.string() }),
        joinedBindings: v.array(v.object({ threadTs: v.string() })),
      }),
      JSON.parse(payload ?? "null"),
    );
    return [record.binding, ...record.joinedBindings].map(
      (binding) => binding.threadTs,
    );
  };

  startWith(userMessage);
  expect(deliveryRows.has(instanceId)).toBe(false);

  startWith(directMessage("181.1"));
  startWith(directMessage("182.2"));
  expect(recordThreads()).toEqual(["181.1", "182.2"]);

  evictLiveSlackDelivery(instanceId);
  delivery = userMessage;
});

test("schedules three-day private and nine-day channel expiry on the extended Durable Object", async () => {
  const agent = createRetentionAgent();
  await agent.refreshRetention("private");
  await agent.refreshRetention("channel");
  expect(agent.scheduled).toEqual([
    {
      callback: "expireConversation",
      payload: { surface: "private" },
      seconds: 259_200,
    },
    {
      callback: "expireConversation",
      payload: { surface: "channel" },
      seconds: 777_600,
    },
  ]);
});

test("destroys through expireLatest so a stale expiry cannot wipe a live conversation", async () => {
  const agent = createRetentionAgent();
  const stale: ExpirySchedule = {
    callback: "expireConversation",
    id: "stale",
    payload: { surface: "private" },
    time: 1,
  };
  const latest: ExpirySchedule = {
    callback: "expireConversation",
    id: "latest",
    payload: { surface: "private" },
    time: 2,
  };
  agent.listed = [stale, latest];
  await agent.expireConversation({ surface: "private" }, stale);
  expect(agent.destroyed).toBe(0);
  await agent.expireConversation({ surface: "private" }, latest);
  expect(agent.destroyed).toBe(1);
});
