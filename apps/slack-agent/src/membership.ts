import { createSqlSlackChannelAdmissionStore } from "@agentic-slack/core";
import type {
  ResolvedAgentConfig,
  RoutedSlackMembership,
  SlackCoreBindings,
} from "@agentic-slack/core";
import * as v from "valibot";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const SLACK_API = "https://slack.com/api/";

const slackEnvelope = v.object({
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
});

const authTestSchema = v.object({
  ok: v.boolean(),
  user_id: v.optional(v.string()),
});

const retryableStatus = (status: number): boolean =>
  status === 429 || status >= 500;

const slackRefusal = async (
  fetcher: Fetcher,
  token: string,
  method: string,
  body: Record<string, string>,
): Promise<string | undefined> => {
  const response = await fetcher(`${SLACK_API}${method}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  if (retryableStatus(response.status)) {
    throw new Error(`Slack ${method} failed: ${response.status}`);
  }
  const result = v.parse(slackEnvelope, await response.json());
  return result.ok === true
    ? undefined
    : (result.error ?? `status ${response.status}`);
};

const botUserId = async (fetcher: Fetcher, token: string): Promise<string> => {
  const response = await fetcher(`${SLACK_API}auth.test`, {
    body: "",
    headers: { authorization: `Bearer ${token}` },
    method: "POST",
  });
  const result = v.parse(authTestSchema, await response.json());
  const { user_id: userId } = result;
  if (!result.ok || userId === undefined || userId === "") {
    throw new Error("Slack auth.test did not report the bot's user id");
  }
  return userId;
};

const channelGuardNotice = (
  channelId: string,
  inviterId: string,
  leaveRefusal: string | undefined,
): string => {
  const channel = `<#${channelId}>`;
  const invited =
    inviterId === "" ? "" : ` after <@${inviterId}> added me there`;
  return leaveRefusal === undefined
    ? `I left ${channel}${invited}. I only act in channels an allowed user invited me to.`
    : `I could not leave ${channel}${invited} (Slack said ${leaveRefusal}), so remove me from it. I only act in channels an allowed user invited me to.`;
};

// A leave Slack refuses for good cannot be fixed by redelivering the event, and
// the admission is already gone, so it is reported rather than retried; a
// refused owner DM is expected when the allowlist names another workspace.
const leaveChannel = async (
  fetcher: Fetcher,
  token: string,
  channelId: string,
): Promise<string | undefined> => {
  const refusal = await slackRefusal(fetcher, token, "conversations.leave", {
    channel: channelId,
  });
  if (refusal !== undefined) {
    console.error("Slack conversations.leave failed", channelId, refusal);
  }
  return refusal;
};

const notifyOwners = async (
  fetcher: Fetcher,
  token: string,
  ownerIds: readonly string[],
  membership: RoutedSlackMembership,
  leaveRefusal: string | undefined,
): Promise<void> => {
  const text = channelGuardNotice(
    membership.channelId,
    membership.inviterId,
    leaveRefusal,
  );
  for (const ownerId of ownerIds) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      const refusal = await slackRefusal(fetcher, token, "chat.postMessage", {
        channel: ownerId,
        text,
      });
      if (refusal !== undefined) {
        console.error("Slack channel guard notice failed", ownerId, refusal);
      }
    } catch (error: unknown) {
      console.error("Slack channel guard notice failed", ownerId, error);
    }
  }
};

export const createMembershipHandler =
  (config: ResolvedAgentConfig, botToken: string, fetcher: Fetcher = fetch) =>
  async (
    membership: RoutedSlackMembership,
    bindings: SlackCoreBindings,
  ): Promise<void> => {
    if (membership.userId !== (await botUserId(fetcher, botToken))) {
      return;
    }
    const store = createSqlSlackChannelAdmissionStore(bindings.DB);
    if (
      membership.inviterId !== "" &&
      (config.allowedUserIds.length === 0 ||
        config.allowedUserIds.includes(membership.inviterId))
    ) {
      await store.admit(membership.channelId, membership.inviterId, Date.now());
      return;
    }
    await store.drop(membership.channelId);
    const leaveRefusal = await leaveChannel(
      fetcher,
      botToken,
      membership.channelId,
    );
    await notifyOwners(
      fetcher,
      botToken,
      config.allowedUserIds,
      membership,
      leaveRefusal,
    );
  };
