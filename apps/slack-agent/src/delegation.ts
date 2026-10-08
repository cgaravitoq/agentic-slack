import { waitUntil } from "cloudflare:workers";
import { createDelegation, workerSecretValue } from "@agentic-slack/core";
import type {
  Delegation,
  DelegationNotice,
  SlackCoreBindings,
} from "@agentic-slack/core";
import config from "../agent.config.ts";

export const configuredDelegation = (
  bindings: SlackCoreBindings,
  botToken: string,
  narrateNotice?: (notice: DelegationNotice) => Promise<void>,
): Delegation | undefined => {
  if (config.delegation === undefined) {
    return undefined;
  }
  const runnerHeaders = Object.fromEntries(
    Object.entries(config.delegation.runnerHeaders ?? {}).map(
      ([header, secret]) => [header, workerSecretValue(bindings, secret) ?? ""],
    ),
  );
  return createDelegation(config.delegation, {
    bearer: workerSecretValue(bindings, config.delegation.authSecret) ?? "",
    botToken,
    cancelSchedule: (instanceId, taskId) =>
      bindings.FLUE_SLACK_AGENT_AGENT.getByName(
        instanceId,
      ).cancelDelegationExpiry(taskId),
    db: bindings.DB,
    narrateNotice,
    runnerHeaders,
    schedule: (instanceId, task) =>
      bindings.FLUE_SLACK_AGENT_AGENT.getByName(
        instanceId,
      ).scheduleDelegationExpiry(task.id, task.expiresAt),
    waitUntil,
  });
};
