import { defineConfig } from "@flue/runtime/config";

// Flue loads this module by convention; nothing imports its default export.
/** @public */
export default defineConfig({
  app: "src/index.ts",
  providers: ["cloudflare"],
  target: "cloudflare",
});
