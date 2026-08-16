import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // Unsatisfiable with require-await and await-thenable for synchronous
    // doubles that must implement a Promise-returning interface.
    "typescript/promise-function-async": "off",
  },
});
