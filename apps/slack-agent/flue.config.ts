import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  target: "cloudflare",
  app: "src/index.ts",
  providers: ["cloudflare"],
});
