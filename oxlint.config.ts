import { defineConfig } from "oxlint";
import antislop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antislop],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Unsatisfiable with require-await and await-thenable for synchronous
    // doubles that must implement a Promise-returning interface.
    "typescript/promise-function-async": "off",
  },
});
