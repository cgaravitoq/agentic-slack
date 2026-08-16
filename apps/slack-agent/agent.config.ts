import { defineAgentConfig } from "@agentic-slack/core";

export default defineAgentConfig({
  description: "A private, self-hosted assistant for Slack conversations.",
  name: "Slack Agent",
  ownerInstructions:
    "Help the owner and their teammates with clear, accurate, concise answers.",
});
