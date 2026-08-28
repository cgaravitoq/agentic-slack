import { setSuggestedPrompts } from "@agentic-slack/core";
import type {
  ResolvedAgentConfig,
  RoutedSlackLifecycle,
} from "@agentic-slack/core";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export const createLifecycleHandler =
  (config: ResolvedAgentConfig, botToken: string, fetcher?: Fetcher) =>
  (lifecycle: RoutedSlackLifecycle): Promise<void> =>
    setSuggestedPrompts(
      { channelId: lifecycle.channelId, threadTs: lifecycle.threadTs },
      config.suggestedPrompts,
      botToken,
      fetcher,
    );
