import { defineAgentConfig } from "@agentic-slack/core";

export default defineAgentConfig({
  name: "Slack Agent",
  description: "A private, self-hosted assistant for Slack conversations.",
  ownerInstructions:
    "Help the owner and their teammates with clear, accurate, concise answers.",
});
