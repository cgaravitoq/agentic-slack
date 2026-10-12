import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const agentConfigOverride = process.env.AGENT_CONFIG;
const agentConfig = path.resolve(
  agentConfigOverride === undefined || agentConfigOverride === ""
    ? path.join(import.meta.dirname, "agent.config.ts")
    : agentConfigOverride,
);

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: process.env.WORKER_OUT_DIR ?? "dist",
  },
  plugins: [
    flue(),
    cloudflare({
      config: flueWorkerConfig(),
      configPath: process.env.WORKER_CONFIG ?? "wrangler.jsonc",
    }),
  ],
  // The agent modules import the config by a relative specifier, so the
  // override aliases that specifier instead of rewriting the import.
  resolve: {
    alias: [
      { find: "../agent.config.ts", replacement: agentConfig },
      {
        find: "@agentic-slack/core",
        replacement: path.resolve(
          import.meta.dirname,
          "../../packages/core/src/index.ts",
        ),
      },
    ],
  },
  root: import.meta.dirname,
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(import.meta.dirname),
        path.dirname(agentConfig),
      ],
    },
  },
});
