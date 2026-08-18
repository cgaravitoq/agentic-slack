import * as v from "valibot";
import type { SuggestedPrompt } from "./config.ts";
import type { SlackDestination } from "./delivery.ts";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const slackResponse = v.object({
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
});

export const setSuggestedPrompts = async (
  destination: SlackDestination,
  prompts: readonly SuggestedPrompt[],
  token: string,
  fetcher: Fetcher = fetch,
): Promise<void> => {
  if (prompts.length === 0) {
    return;
  }
  const response = await fetcher(
    "https://slack.com/api/assistant.threads.setSuggestedPrompts",
    {
      body: JSON.stringify({
        channel_id: destination.channelId,
        prompts: prompts.map((prompt) => ({
          message: prompt.message,
          title: prompt.title,
        })),
        thread_ts: destination.threadTs,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
    },
  );
  const result = v.parse(slackResponse, await response.json());
  if (result.ok !== true) {
    throw new Error(
      `Slack assistant.threads.setSuggestedPrompts failed: ${result.error ?? response.status}`,
    );
  }
};
