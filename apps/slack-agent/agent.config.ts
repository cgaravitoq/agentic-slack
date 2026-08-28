import { defineAgentConfig } from "@agentic-slack/core";

export default defineAgentConfig({
  description: "A private, self-hosted assistant for Slack conversations.",
  model: "cloudflare/@cf/zai-org/glm-4.7-flash",
  name: "Slack Agent",
  ownerInstructions:
    "Help the owner and their teammates with clear, accurate, concise answers.",
  retention: {
    channelDays: 15,
    privateDays: 7,
  },
  suggestedPrompts: [
    {
      message:
        "Summarize this conversation and list the decisions and next steps.",
      title: "Summarize",
    },
    {
      message: "Draft a concise reply I can send in this thread.",
      title: "Draft a reply",
    },
    {
      message: "Explain the latest message in plain language.",
      title: "Explain",
    },
    {
      message: "Extract action items, owners, and due dates from this thread.",
      title: "Action items",
    },
  ],
});
