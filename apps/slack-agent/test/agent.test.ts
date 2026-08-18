import { expect, mock, test } from "bun:test";
import { composeInstructions, defineAgentConfig } from "@agentic-slack/core";
import type { AgentPlugin } from "@agentic-slack/core";
import type { FlueLogger } from "@flue/runtime";
import { defineTool } from "@flue/runtime/tool";
import type { ToolDefinition } from "@flue/runtime/tool";
import * as v from "valibot";

import defaultConfig from "../agent.config.ts";
import { mockCloudflareWorkers } from "./module-mocks.ts";

const noopLogger: FlueLogger = {
  error() {},
  info() {},
  warn() {},
};
const runContext = <T>(data: T) => ({
  data,
  log: noopLogger,
  toolCallId: "test-call",
});

const defaultPlugins = [...defaultConfig.plugins];
const defaultAddons = [...defaultConfig.addons];
const pluginSecret = "extension-secret-value";
const bindings = {
  EXTENSION_SECRET: pluginSecret,
  SLACK_BOT_TOKEN: "xoxb-test-token",
};
const instructions: string[] = [];
const tools: ToolDefinition[] = [];
let resolvedSecret: string | undefined;

interface RuntimeContext {
  bindings: typeof bindings;
}

const plugin: AgentPlugin<RuntimeContext> = {
  createTools(context) {
    const secret = context.bindings.EXTENSION_SECRET;
    return [
      defineTool({
        description: "Run a lookup with operator-provided credentials.",
        input: v.object({ query: v.string() }),
        name: "runtime_context",
        run() {
          resolvedSecret = secret;
          return Promise.resolve({ output: "lookup complete" });
        },
      }),
    ];
  },
  id: "runtime-context",
  instructions: ["Use runtime_context for a safe lookup."],
  kind: "plugin",
};

const extensionConfig = defineAgentConfig<RuntimeContext>({
  description: "Exercises extension composition.",
  name: "Extended Agent",
  ownerInstructions: "Keep credentials private.",
  plugins: [plugin],
});

await mockCloudflareWorkers(bindings);
await mock.module("../agent.config.ts", () => ({ default: extensionConfig }));
const runtime = await import("@flue/runtime");
await mock.module("@flue/runtime", () => ({
  ...runtime,
  useInstruction: (instruction: string) => instructions.push(instruction),
  useModel: () => {},
  useTool: (tool: ToolDefinition) => tools.push(tool),
}));
// The spread keeps the mocked export list as wide as the real module: Bun
// freezes it on first use, so a narrow mock breaks whichever test file loads
// next and the breakage only shows up in one test-file order.
const cloudflare = await import("@flue/runtime/cloudflare");
await mock.module("@flue/runtime/cloudflare", () => ({
  ...cloudflare,
  extend: () => ({ base: undefined }),
}));

const { SlackAgent } = await import("../src/agent.ts");

test("default agent configuration remains core-only", () => {
  expect(defaultPlugins).toEqual([]);
  expect(defaultAddons).toEqual([]);
});

test("package.json pins plugin workspace deps for import resolution", async () => {
  const packageJson = v.parse(
    v.object({ dependencies: v.record(v.string(), v.string()) }),
    await Bun.file(new URL("../package.json", import.meta.url)).json(),
  );
  expect(packageJson.dependencies["@agentic-slack/plugin-llms-docs"]).toBe(
    "workspace:*",
  );
  expect(packageJson.dependencies["@agentic-slack/plugin-posthog"]).toBe(
    "workspace:*",
  );
});

test("passes Worker bindings to plugins without model-visible secrets", async () => {
  expect(SlackAgent({ id: "test" })).toBe(
    "Extended Agent: Exercises extension composition.",
  );
  expect(instructions).toEqual([...composeInstructions(extensionConfig)]);
  const modelVisible = JSON.stringify({
    instructions,
    tools: tools.map(({ name, description, input }) => ({
      description,
      input,
      name,
    })),
  });
  expect(modelVisible).not.toContain(pluginSecret);

  await tools[0]?.run(runContext({ query: "invoice" }));
  expect(resolvedSecret).toBe(pluginSecret);
});
