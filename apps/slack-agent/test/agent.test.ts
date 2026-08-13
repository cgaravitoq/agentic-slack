import { expect, mock, test } from "bun:test";
import {
  composeInstructions,
  defineAgentConfig,
  type AgentPlugin,
} from "@agentic-slack/core";
import { defineTool, type ToolDefinition } from "@flue/runtime/tool";
import * as v from "valibot";

import defaultConfig from "../agent.config.ts";

const defaultPlugins = [...defaultConfig.plugins];
const defaultAddons = [...defaultConfig.addons];
const pluginSecret = "extension-secret-value";
const bindings = {
  SLACK_BOT_TOKEN: "xoxb-test-token",
  EXTENSION_SECRET: pluginSecret,
};
const instructions: string[] = [];
const tools: ToolDefinition[] = [];
let resolvedSecret: string | undefined;

interface RuntimeContext {
  bindings: typeof bindings;
}

const plugin: AgentPlugin<RuntimeContext> = {
  id: "runtime-context",
  kind: "plugin",
  instructions: ["Use runtime_context for a safe lookup."],
  createTools(context) {
    const secret = context.bindings.EXTENSION_SECRET;
    return [
      defineTool({
        name: "runtime_context",
        description: "Run a lookup with operator-provided credentials.",
        input: v.object({ query: v.string() }),
        async run() {
          resolvedSecret = secret;
          return { output: "lookup complete" };
        },
      }),
    ];
  },
};

const extensionConfig = defineAgentConfig<RuntimeContext>({
  name: "Extended Agent",
  description: "Exercises extension composition.",
  ownerInstructions: "Keep credentials private.",
  plugins: [plugin],
});

await mock.module("cloudflare:workers", () => ({ env: bindings }));
await mock.module("../agent.config.ts", () => ({ default: extensionConfig }));
await mock.module("@flue/runtime", () => ({
  useInitialData: () => ({
    teamId: "T123",
    channelId: "C123",
    threadTs: "171.2",
    surface: "private",
  }),
  useInstruction: (instruction: string) => instructions.push(instruction),
  useModel: () => undefined,
  useTool: (tool: ToolDefinition) => tools.push(tool),
}));
await mock.module("@flue/runtime/cloudflare", () => ({
  extend: () => ({ base: undefined }),
}));

const { SlackAgent } = await import("../src/agent.ts");

test("default agent configuration remains core-only", () => {
  expect(defaultPlugins).toEqual([]);
  expect(defaultAddons).toEqual([]);
});

test("package.json pins plugin workspace deps for import resolution", async () => {
  const packageJson = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  expect(packageJson.dependencies["@agentic-slack/plugin-llms-docs"]).toBe(
    "workspace:*",
  );
  expect(packageJson.dependencies["@agentic-slack/plugin-posthog"]).toBe(
    "workspace:*",
  );
});

test("passes Worker bindings to plugins without model-visible secrets", async () => {
  expect(SlackAgent({} as never)).toBe(
    "Extended Agent: Exercises extension composition.",
  );
  expect(instructions).toEqual([...composeInstructions(extensionConfig)]);
  const modelVisible = JSON.stringify({
    instructions,
    tools: tools.map(({ name, description, input }) => ({
      name,
      description,
      input,
    })),
  });
  expect(modelVisible).not.toContain(pluginSecret);

  await tools[0]?.run({ data: { query: "invoice" } } as never);
  expect(resolvedSecret).toBe(pluginSecret);
});
