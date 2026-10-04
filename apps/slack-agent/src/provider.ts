import { MODEL_PROVIDER_CLOUDFLARE } from "@agentic-slack/core";
import type { ModelProvider, SlackCoreBindings } from "@agentic-slack/core";
import type { setProvider } from "@flue/runtime";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";

type RuntimeProvider = Parameters<typeof setProvider>[0];

// Flue resolves `provider-id/model-id` against the providers registered here,
// so the config's model prefix and this map are the one place that pairs a
// deployment's chosen backend with the binding it needs.
const providerFactories = {
  [MODEL_PROVIDER_CLOUDFLARE]: (bindings: SlackCoreBindings) =>
    cloudflareBindingProvider({ binding: bindings.AI, gateway: false }),
} satisfies Record<
  ModelProvider,
  (bindings: SlackCoreBindings) => RuntimeProvider
>;

export const selectProvider = (
  modelProvider: ModelProvider,
  bindings: SlackCoreBindings,
): RuntimeProvider => providerFactories[modelProvider](bindings);
