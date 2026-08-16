import { defineConfig } from "@flue/runtime/config";

export default defineConfig({
  app: "src/index.ts",
  providers: ["cloudflare"],
  target: "cloudflare",
});
