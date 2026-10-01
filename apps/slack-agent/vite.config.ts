import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";

const agentConfig = path.resolve(
  process.env.AGENT_CONFIG ?? path.join(import.meta.dirname, "agent.config.ts"),
);

export default defineConfig({
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
    alias: [{ find: "../agent.config.ts", replacement: agentConfig }],
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
