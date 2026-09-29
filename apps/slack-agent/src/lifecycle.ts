import { setSuggestedPrompts } from "@agentic-slack/core";
import type {
  ResolvedAgentConfig,
  RoutedSlackLifecycle,
} from "@agentic-slack/core";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export const createLifecycleHandler =
  (config: ResolvedAgentConfig, botToken: string, fetcher?: Fetcher) =>
  async (lifecycle: RoutedSlackLifecycle): Promise<void> => {
    try {
      await setSuggestedPrompts(
        { channelId: lifecycle.channelId, threadTs: lifecycle.threadTs },
        config.suggestedPrompts,
        botToken,
        fetcher,
      );
    } catch (error: unknown) {
      // A prompt Slack refuses cannot succeed on a redelivery, and failing the
      // ack would spend all three of them on the same refusal. The claim stays,
      // so the retry is deduplicated instead.
      console.error("Slack assistant prompts failed", error);
    }
  };
