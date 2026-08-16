import { describe, expect, test } from "bun:test";
import type { ConversationLifecycleAgent } from "@agentic-slack/core";
import * as v from "valibot";
import { createApp } from "../src/app.ts";

const workerBindings = v.object({
  AI: v.custom<Ai>(
    (value): value is Ai => value !== null && typeof value === "object",
  ),
  DB: v.custom<D1Database>(
    (value): value is D1Database => value !== null && typeof value === "object",
  ),
  FLUE_SLACK_AGENT_AGENT: v.custom<
    DurableObjectNamespace<ConversationLifecycleAgent>
  >(
    (value): value is DurableObjectNamespace<ConversationLifecycleAgent> =>
      value !== null && typeof value === "object",
  ),
});

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
    if (!v.is(workerBindings, rawBindings)) {
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
