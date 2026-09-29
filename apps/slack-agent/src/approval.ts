import {
  createApprovalNotifier,
  createApprovalStore,
  decisionMessage,
  handleApprovalInteraction,
  refreshRetention,
  slackDeliveryBindingSchema,
} from "@agentic-slack/core";
import type {
  ApprovalDecision,
  ApprovalRequest,
  SlackBlockActionsPayload,
  SlackCoreBindings,
} from "@agentic-slack/core";
import { init } from "@flue/runtime";
import * as v from "valibot";
import { SlackAgent } from "./agent.ts";

const dispatchDecision = async (
  request: ApprovalRequest,
  decision: ApprovalDecision,
  bindings: SlackCoreBindings,
): Promise<void> => {
  await refreshRetention(
    bindings.FLUE_SLACK_AGENT_AGENT,
    request.conversationId,
    request.surface,
  );
  const handle = init(SlackAgent, { id: request.conversationId });
  await handle.dispatch({
    idempotencyKey: `approval:${request.requestId}:${decision}`,
    message: {
      attributes: {
        ...v.parse(slackDeliveryBindingSchema, {
          channelId: request.channelId,
          recipientTeamId: request.teamId,
          recipientUserId: request.requesterId,
          surface: request.surface,
          threadTs: request.threadTs,
        }),
        event_id: `approval:${request.requestId}`,
        message_ts: request.messageTs,
        user: request.requesterId,
      },
      body: decisionMessage(request, decision),
      kind: "signal",
      type: "slack.approval",
    },
  });
};

export const createApprovalHandler =
  (botToken: string) =>
  async (
    payload: SlackBlockActionsPayload,
    bindings: SlackCoreBindings,
  ): Promise<void> => {
    await handleApprovalInteraction(payload, {
      decide: (request, decision) =>
        dispatchDecision(request, decision, bindings),
      notifier: createApprovalNotifier(botToken),
      store: createApprovalStore(bindings.DB),
    });
  };
