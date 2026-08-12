import { describe, expect, test } from "bun:test";
import type { SlackCoreBindings } from "@agentic-slack/core";
import { createApp } from "../src/app.ts";

const trusted = {
  signingSecret: "signing-secret",
  botToken: "bot-token",
  teamId: "team-id",
  appId: "app-id",
};

describe("GET /health", () => {
  test("is ready only with complete Slack configuration and bindings", async () => {
    const app = createApp(trusted, async () => {});
    const bindings = {
      DB: {},
      FLUE_SLACK_AGENT_AGENT: {},
      AI: {},
    } as unknown as SlackCoreBindings;
    const ready = await app.request("/health", undefined, bindings);
    expect(ready.status).toBe(200);
    expect(JSON.parse(await ready.text())).toEqual({ status: "ready" });

    const unavailable = await app.request("/health", undefined, {});
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(await unavailable.text())).toEqual({
      status: "not_ready",
      missing: ["DB", "FLUE_SLACK_AGENT_AGENT", "AI"],
    });

    const incomplete = createApp({ ...trusted, teamId: "" }, async () => {});
    const incompleteResponse = await incomplete.request(
      "/health",
      undefined,
      bindings,
    );
    expect(incompleteResponse.status).toBe(503);
    expect(JSON.parse(await incompleteResponse.text())).toEqual({
      status: "not_ready",
      missing: ["SLACK_TEAM_ID"],
    });
  });
});
