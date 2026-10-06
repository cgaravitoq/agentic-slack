import { expect, test } from "bun:test";
import { zstdDecompressSync } from "node:zlib";
import { defineAgentConfig, MODEL_PROVIDER_BROKER } from "@agentic-slack/core";
import type {
  ModelBrokerBinding,
  SlackCoreBindings,
} from "@agentic-slack/core";
import { createModels } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Models,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { ConversationLifecycleAgent } from "../../../packages/core/src/retention.ts";
import { selectProvider } from "../src/provider.ts";

const BROKER_MODEL = "gpt-6-luna";
const TOOL_CALL_NAME = "read_thread";
const TOOL_RESULT_TEXT = "The thread holds three messages.";

// A recorded Codex response, so its model and prompt differ from this test's.
const textFixture = await Bun.file(
  new URL("fixtures/codex-responses-text.sse", import.meta.url),
).text();
const toolCallFixture = await Bun.file(
  new URL("fixtures/codex-responses-tool-call.sse", import.meta.url),
).text();

const contentPart = v.object({ text: v.string(), type: v.string() });

const inputItem = v.object({
  arguments: v.optional(v.string()),
  call_id: v.optional(v.string()),
  content: v.optional(v.array(contentPart)),
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  output: v.optional(v.string()),
  role: v.optional(v.string()),
  type: v.optional(v.string()),
});

const responsesRequest = v.object({
  input: v.array(inputItem),
  model: v.string(),
  stream: v.boolean(),
});

type ResponsesRequest = v.InferOutput<typeof responsesRequest>;

interface BrokerCall {
  body: ResponsesRequest;
  headers: Headers;
  method: string;
  path: string;
}

const requestBody = async (request: Request): Promise<ResponsesRequest> => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const payload =
    request.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes)
      : bytes;
  return v.parse(
    responsesRequest,
    JSON.parse(new TextDecoder().decode(payload)),
  );
};

const fakeBroker = (fixtures: readonly string[]) => {
  const calls: BrokerCall[] = [];
  const remaining = [...fixtures];
  const binding: ModelBrokerBinding = {
    fetch: async (request: Request) => {
      calls.push({
        body: await requestBody(request),
        headers: new Headers(request.headers),
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return new Response(remaining.shift() ?? textFixture, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  };
  return { binding, calls };
};

const workerBindings = v.object({
  AI: v.custom<Ai>(
    (value): value is Ai => value !== null && typeof value === "object",
  ),
  DB: v.custom<D1Database>(
    (value): value is D1Database => value !== null && typeof value === "object",
  ),
  FLUE_SLACK_AGENT_AGENT: v.custom<
    DurableObjectNamespace<ConversationLifecycleAgent>
  >(
    (value): value is DurableObjectNamespace<ConversationLifecycleAgent> =>
      value !== null && typeof value === "object",
  ),
  MODEL_BROKER: v.custom<ModelBrokerBinding>(
    (value): value is ModelBrokerBinding =>
      value !== null && typeof value === "object",
  ),
});

const brokerBindings = (broker: ModelBrokerBinding): SlackCoreBindings => {
  const value = {
    AI: {},
    DB: {},
    FLUE_SLACK_AGENT_AGENT: {},
    MODEL_BROKER: broker,
  };
  if (!v.is(workerBindings, value)) {
    throw new Error("Invalid test bindings");
  }
  return value;
};

const brokerModels = (broker: ModelBrokerBinding): Models => {
  const models = createModels();
  models.setProvider(
    selectProvider(MODEL_PROVIDER_BROKER, brokerBindings(broker)),
  );
  return models;
};

const brokerModel = (models: Models) => {
  const model = models.getModel(MODEL_PROVIDER_BROKER, BROKER_MODEL);
  if (model === undefined) {
    throw new Error(`Broker model ${BROKER_MODEL} is not registered`);
  }
  return model;
};

const userContext = (messages: Context["messages"] = []): Context => ({
  messages: [
    { content: "Read the thread.", role: "user", timestamp: 1 },
    ...messages,
  ],
});

const toolCallOf = (message: AssistantMessage) => {
  const [call] = message.content;
  if (call?.type !== "toolCall") {
    throw new Error("The fixture answered without a tool call");
  }
  return call;
};

test("a broker turn sends its Responses request through the binding only", async () => {
  const network: string[] = [];
  const { binding, calls } = fakeBroker([textFixture]);
  const models = brokerModels(binding);
  const model = brokerModel(models);

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  class RecordingWebSocket extends EventTarget {
    constructor() {
      super();
      network.push("WebSocket");
      throw new Error("The broker path must not open a WebSocket");
    }
  }
  Object.assign(globalThis, {
    WebSocket: RecordingWebSocket,
    fetch: (...args: unknown[]) => {
      network.push(String(args[0]));
      throw new Error("The broker path must not call the global fetch");
    },
  });
  let message: AssistantMessage;
  try {
    message = await models.completeSimple(model, userContext());
  } finally {
    Object.assign(globalThis, {
      WebSocket: originalWebSocket,
      fetch: originalFetch,
    });
  }

  expect(network).toEqual([]);
  expect(message.stopReason).toBe("stop");
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) {
    throw new Error("The binding saw no request");
  }
  expect(call.method).toBe("POST");
  expect(call.path).toBe("/codex/responses");
  expect(call.body.model).toBe(BROKER_MODEL);
  expect(call.body.stream).toBe(true);
  expect(call.headers.get("accept")).toBe("text/event-stream");
  expect(call.headers.get("authorization")).toMatch(/^Bearer \S+\.\S+\.\S+$/u);
  expect(call.headers.get("chatgpt-account-id")).not.toBeNull();
});

test("the broker streams the recorded fixture's text", async () => {
  const { binding } = fakeBroker([textFixture]);
  const models = brokerModels(binding);
  const stream = models.stream(brokerModel(models), userContext());

  const deltas: string[] = [];
  for await (const event of stream) {
    if (event.type === "text_delta") {
      deltas.push(event.delta);
    }
  }
  const message = await stream.result();

  expect(deltas.join("")).toBe("probe");
  expect(message.stopReason).toBe("stop");
  const [block] = message.content;
  expect(block?.type).toBe("text");
  expect(block?.type === "text" ? block.text : "").toBe("probe");
});

test("a tool call's result rides the next request the binding carries", async () => {
  const { binding, calls } = fakeBroker([toolCallFixture, textFixture]);
  const models = brokerModels(binding);
  const model = brokerModel(models);

  const first = await models.completeSimple(model, userContext());
  const toolCall = toolCallOf(first);
  expect(toolCall.name).toBe(TOOL_CALL_NAME);
  expect(toolCall.arguments).toEqual({ channel: "C1" });

  const toolResult: ToolResultMessage = {
    content: [{ text: TOOL_RESULT_TEXT, type: "text" }],
    isError: false,
    role: "toolResult",
    timestamp: 2,
    toolCallId: toolCall.id,
    toolName: TOOL_CALL_NAME,
  };
  const second = await models.completeSimple(
    model,
    userContext([first, toolResult]),
  );

  expect(second.stopReason).toBe("stop");
  expect(calls).toHaveLength(2);
  const [firstCall, secondCall] = calls;
  expect(firstCall?.body.input).toHaveLength(1);
  expect(firstCall?.body.input[0]).toMatchObject({ role: "user" });
  const replay = secondCall?.body.input ?? [];
  expect(replay).toHaveLength(3);
  expect(replay[1]).toMatchObject({
    arguments: JSON.stringify({ channel: "C1" }),
    call_id: "call_1",
    id: "fc_1",
    name: TOOL_CALL_NAME,
    type: "function_call",
  });
  expect(replay[2]).toMatchObject({
    call_id: "call_1",
    output: TOOL_RESULT_TEXT,
    type: "function_call_output",
  });
});

test("the prefix the config names selects the provider that reads the binding", () => {
  const config = defineAgentConfig({
    description: "Runs the model through a broker.",
    model: `${MODEL_PROVIDER_BROKER}/${BROKER_MODEL}`,
    name: "Brokered Agent",
    ownerInstructions: "Be brief.",
  });
  const { binding } = fakeBroker([textFixture]);
  const models = createModels();
  models.setProvider(
    selectProvider(config.modelProvider, brokerBindings(binding)),
  );

  expect(config.modelProvider).toBe(MODEL_PROVIDER_BROKER);
  expect(models.getModel(config.modelProvider, BROKER_MODEL)?.id).toBe(
    BROKER_MODEL,
  );
});
