import { cloudflare } from "@cloudflare/vite-plugin";
import { flue, flueWorkerConfig } from "@flue/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    flue(),
    cloudflare({
      configPath: "wrangler.jsonc",
      config: flueWorkerConfig(),
    }),
  ],
});
