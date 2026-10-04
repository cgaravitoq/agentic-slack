"use agent";

import { env } from "cloudflare:workers";
import {
  applySlackDeliveryEvent,
  composeInstructions,
  createApprovalFetch,
  createApprovalNotifier,
  createApprovalStore,
  createSlackReadTools,
  createSqlSlackDeliveryStore,
  createSqlSlackReadCursorStore,
  expireLatest,
  failSlackDelivery,
  finishSlackDelivery,
  openSlackDelivery,
  replaceRetention,
  slackDeliveryBindingSchema,
  slackEventFromObservation,
} from "@agentic-slack/core";
import type {
  ApprovalGateContext,
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
  useTool,
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

// Flue mounts an MCP server's tools whole, and a gated call has to be stopped
// on its way to the server, so the approval sits in the connection's transport
// instead of in the tool set: the gate sees the exact call, refuses it before
// anything leaves the Worker, and forwards it once a person approves that call.
const approvalFetch = (
  requireApproval: readonly string[],
  instanceId: string,
) => {
  const context = (): ApprovalGateContext | undefined => {
    const record = deliveryStore().load(instanceId);
    if (record === undefined) {
      return undefined;
    }
    return {
      appId: env.SLACK_APP_ID,
      channelId: record.binding.channelId,
      conversationId: instanceId,
      requesterId: record.binding.recipientUserId,
      surface: record.binding.surface,
      teamId: record.binding.recipientTeamId,
      threadTs: record.binding.threadTs,
    };
  };
  return createApprovalFetch({
    context,
    gated: (tool) => requireApproval.includes(tool),
    notifier: createApprovalNotifier(botToken()),
    store: createApprovalStore(env.DB),
  });
};

const startSlackTurnDelivery = (
  instanceId: string,
  binding: SlackDeliveryBinding,
): void => {
  openSlackDelivery(deliveryStore(), instanceId, binding, botToken());
};

const observeSlackTurnDelivery = (
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

const finishSlackTurnDelivery = (instanceId: string): Promise<void> =>
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
  for (const { authSecret, requireApproval, ...server } of config.mcpServers) {
    const connection: McpConnectionDefinition = { ...server };
    if (authSecret !== undefined) {
      connection.auth = () => workerSecret(authSecret);
    }
    if (requireApproval !== undefined && requireApproval.length > 0) {
      // Flue types the transport's fetch as the global one, which also carries
      // the runtime's `preconnect` hint; forwarding it keeps the wrapper
      // indistinguishable from the fetch it replaces.
      connection.fetch = Object.assign(
        approvalFetch(requireApproval, props.id),
        { preconnect: fetch.preconnect },
      );
    }
    useMcpConnection(connection);
  }
  const delivery = useDelivery();
  if (config.read !== undefined && delivery.kind === "signal") {
    const slack = v.safeParse(slackDeliveryBindingSchema, delivery.attributes);
    if (slack.success) {
      const cursorStore = createSqlSlackReadCursorStore(env.DB);
      const tools = createSlackReadTools(slack.output, {
        cursorStore,
        lookbackSeconds: config.read.lookbackSeconds,
        maxMessages: config.read.maxMessages,
        token: botToken(),
      });
      for (const tool of tools) {
        useTool(tool);
      }
    }
  }
  useAgentStart(() => {
    if (delivery.kind !== "signal") {
      return;
    }
    startSlackTurnDelivery(
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
