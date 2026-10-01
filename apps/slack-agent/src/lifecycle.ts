import { waitUntil } from "cloudflare:workers";
import { setSuggestedPrompts } from "@agentic-slack/core";
import type {
  ResolvedAgentConfig,
  RoutedSlackLifecycle,
} from "@agentic-slack/core";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export const createLifecycleHandler =
  (config: ResolvedAgentConfig, botToken: string, fetcher?: Fetcher) =>
  (lifecycle: RoutedSlackLifecycle): void => {
    // The prompts are best-effort, and Slack budgets three seconds for the ack
    // this handler runs inside, so the call must not hold it open. The claim is
    // already durable, so a Slack redelivery is deduplicated instead of
    // re-running a refusal that cannot succeed.
    waitUntil(
      (async () => {
        try {
          await setSuggestedPrompts(
            { channelId: lifecycle.channelId, threadTs: lifecycle.threadTs },
            config.suggestedPrompts,
            botToken,
            fetcher,
          );
        } catch (error: unknown) {
          console.error("Slack assistant prompts failed", error);
        }
      })(),
    );
  };
