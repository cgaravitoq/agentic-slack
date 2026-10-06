import { describe, expect, test } from "bun:test";
import {
  MODEL_PROVIDER_BROKER,
  MODEL_PROVIDER_CLOUDFLARE,
} from "@agentic-slack/core";
import type { ConversationLifecycleAgent } from "../../../packages/core/src/retention.ts";
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
  test("requires AI, and not the broker binding, for a Workers AI model", async () => {
    const app = createApp(trusted, MODEL_PROVIDER_CLOUDFLARE, async () => {});
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

    const incomplete = createApp(
      { ...trusted, teamId: "" },
      MODEL_PROVIDER_CLOUDFLARE,
      async () => {},
    );
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

  test("requires the broker binding, and not AI, for a brokered model", async () => {
    const app = createApp(trusted, MODEL_PROVIDER_BROKER, async () => {});
    const ready = await app.request("/health", undefined, {
      DB: {},
      FLUE_SLACK_AGENT_AGENT: {},
      MODEL_BROKER: { fetch: () => Promise.resolve(new Response(null)) },
    });
    expect(ready.status).toBe(200);
    expect(JSON.parse(await ready.text())).toEqual({ status: "ready" });

    const withoutBroker = await app.request("/health", undefined, {
      AI: {},
      DB: {},
      FLUE_SLACK_AGENT_AGENT: {},
    });
    expect(withoutBroker.status).toBe(503);
    expect(JSON.parse(await withoutBroker.text())).toEqual({
      missing: ["MODEL_BROKER"],
      status: "not_ready",
    });
  });
});
