import {
  MODEL_PROVIDER_BROKER,
  MODEL_PROVIDER_CLOUDFLARE,
} from "@agentic-slack/core";
import type {
  ModelBrokerBinding,
  ModelProvider,
  SlackCoreBindings,
} from "@agentic-slack/core";
import { createProvider } from "@earendil-works/pi-ai";
import type {
  Api,
  FetchFunction,
  Model,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { setProvider } from "@flue/runtime";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";

type RuntimeProvider = Parameters<typeof setProvider>[0];

// pi-ai derives this URL from the model catalog and the fetch below replaces
// it: a service binding routes by binding, so only the path survives.
const BROKER_RESPONSES_URL = "https://broker.invalid/codex/responses";

const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

// pi-ai reads the account id out of the bearer before every request, so this
// token only has to parse: the broker overwrites the bearer, the account header
// and every hop header before it calls the model.
const PLACEHOLDER_TOKEN = [
  btoa(JSON.stringify({ alg: "none", typ: "JWT" })),
  btoa(
    JSON.stringify({
      [ACCOUNT_ID_CLAIM]: { chatgpt_account_id: "credential-broker" },
    }),
  ),
  "placeholder",
].join(".");

const brokerFetch = (broker: ModelBrokerBinding): FetchFunction =>
  // Flue types the stream's fetch as the global one, which also carries the
  // runtime's `preconnect` hint; forwarding it keeps the wrapper
  // indistinguishable from the fetch it replaces.
  Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const upstream =
        input instanceof Request ? input : new Request(String(input), init);
      return broker.fetch(new Request(BROKER_RESPONSES_URL, upstream));
    },
    { preconnect: globalThis.fetch.preconnect },
  );

const brokerStreams = (
  streams: ProviderStreams,
  broker: ModelBrokerBinding,
): ProviderStreams => {
  const fetch = brokerFetch(broker);
  // pi-ai's WebSocket transport ignores `options.fetch`, so the broker can
  // only carry the SSE transport; SSE is what the broker answers.
  return {
    stream: (model, context, options) =>
      streams.stream(model, context, { ...options, fetch, transport: "sse" }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, {
        ...options,
        fetch,
        transport: "sse",
      }),
  };
};

const brokerProvider = (broker: ModelBrokerBinding): RuntimeProvider => {
  const models: readonly Model<Api>[] = openaiCodexProvider()
    .getModels()
    .map((model) => ({ ...model, provider: MODEL_PROVIDER_BROKER }));
  return createProvider({
    api: brokerStreams(openAICodexResponsesApi(), broker),
    auth: {
      apiKey: {
        name: "Model credential broker",
        resolve: () =>
          Promise.resolve({
            auth: { apiKey: PLACEHOLDER_TOKEN },
            source: "MODEL_BROKER",
          }),
      },
    },
    id: MODEL_PROVIDER_BROKER,
    models,
    name: "Model credential broker",
  });
};

// Flue resolves `provider-id/model-id` against the providers registered here,
// so the config's model prefix and this map are the one place that pairs a
// deployment's chosen backend with the binding it needs.
const providerFactories = {
  [MODEL_PROVIDER_BROKER]: (bindings: SlackCoreBindings) =>
    brokerProvider(bindings.MODEL_BROKER),
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
