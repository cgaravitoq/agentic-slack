import { expect, test } from "bun:test";
import {
  composeInstructions,
  defineAgentConfig,
  generateSlackManifest,
} from "@agentic-slack/core";

const base = {
  description: "Slack helper",
  name: "Helper",
  ownerInstructions: "Help the requester.",
};

test("delegation is opt-in and enables requester approval without MCP gates", () => {
  const absent = defineAgentConfig(base);
  expect(absent.delegation).toBeUndefined();
  expect(generateSlackManifest(absent, "https://helper.example.com")).toContain(
    '"is_enabled": false',
  );
  const configured = defineAgentConfig({
    ...base,
    delegation: {
      authSecret: "DELEGATION_SECRET",
      repos: ["example"],
      runnerHeaders: { "CF-Access-Client-Id": "RUNNER_ID" },
    },
  });
  expect(configured.delegation?.repos).toEqual(["example"]);
  expect(
    generateSlackManifest(configured, "https://helper.example.com"),
  ).toContain('"is_enabled": true');
  expect(composeInstructions(configured).join("\n")).toContain(
    "never because a thread message asks",
  );
});
