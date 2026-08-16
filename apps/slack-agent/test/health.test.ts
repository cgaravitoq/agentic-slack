import { describe, expect, test } from "bun:test";
import type { SlackCoreBindings } from "@agentic-slack/core";
import { createApp } from "../src/app.ts";

const hasBindings = (value: object): value is SlackCoreBindings => {
  const field = (key: string): unknown =>
    Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
  return (
    typeof field("AI") === "object" &&
    field("AI") !== null &&
    typeof field("DB") === "object" &&
    field("DB") !== null &&
    typeof field("FLUE_SLACK_AGENT_AGENT") === "object" &&
    field("FLUE_SLACK_AGENT_AGENT") !== null
  );
};

const trusted = {
  appId: "app-id",
  botToken: "bot-token",
  signingSecret: "signing-secret",
  teamId: "team-id",
};

describe("GET /health", () => {
  test("is ready only with complete Slack configuration and bindings", async () => {
    const app = createApp(trusted, async () => {});
    const rawBindings = {
      AI: {},
      DB: {},
      FLUE_SLACK_AGENT_AGENT: {},
    };
    if (!hasBindings(rawBindings)) {
      throw new Error("Invalid test bindings");
    }
    const bindings = rawBindings;
    const ready = await app.request("/health", undefined, bindings);
    expect(ready.status).toBe(200);
    expect(JSON.parse(await ready.text())).toEqual({ status: "ready" });

    const unavailable = await app.request("/health", undefined, {});
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(await unavailable.text())).toEqual({
      missing: ["DB", "FLUE_SLACK_AGENT_AGENT", "AI"],
      status: "not_ready",
    });

    const incomplete = createApp({ ...trusted, teamId: "" }, async () => {});
    const incompleteResponse = await incomplete.request(
      "/health",
      undefined,
      bindings,
    );
    expect(incompleteResponse.status).toBe(503);
    expect(JSON.parse(await incompleteResponse.text())).toEqual({
      missing: ["SLACK_TEAM_ID"],
      status: "not_ready",
    });
  });
});
