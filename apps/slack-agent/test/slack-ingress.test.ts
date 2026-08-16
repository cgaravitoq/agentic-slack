import { describe, expect, test } from "bun:test";
import { createSlackIngress } from "@agentic-slack/core";
import type { SlackCoreBindings } from "@agentic-slack/core";

const trusted = {
  appId: "A123",
  botToken: "xoxb-test",
  signingSecret: "signing-secret-for-tests-1234567890",
  teamId: "T123",
};

class FakeD1 {
  readonly seen = new Set<string>();
  private values: unknown[] = [];

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        this.values = values;
        return this.prepare(sql);
      },
      run: () => {
        const eventId = String(this.values[0]);
        if (sql.startsWith("INSERT")) {
          if (this.seen.has(eventId)) {
            return Promise.resolve({ meta: { changes: 0 } });
          }
          this.seen.add(eventId);
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (sql.startsWith("DELETE FROM seen_events WHERE event_id")) {
          this.seen.delete(eventId);
        }
        return Promise.resolve({ meta: { changes: 1 } });
      },
    };
  }
}

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

const testBindings = (db: FakeD1): SlackCoreBindings => {
  const value = {
    AI: {},
    DB: db,
    FLUE_SLACK_AGENT_AGENT: {},
  };
  if (!hasBindings(value)) {
    throw new Error("Invalid test bindings");
  }
  return value;
};

const signedRequest = async (payload: object): Promise<Request> => {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(trusted.signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const signature = `v0=${Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  return new Request("https://example.com/events", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
};

const event = (overrides: Record<string, unknown> = {}) => ({
  api_app_id: "A123",
  event: {
    channel: "C123",
    text: "<@UAPP> hello",
    ts: "171.1",
    type: "app_mention",
    user: "U123",
    ...overrides,
  },
  event_id: "Ev123",
  team_id: "T123",
  type: "event_callback",
});

describe("signed Slack ingress", () => {
  test("acks before work and deduplicates all side effects by event_id", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    const { promise: blocked, resolve: releaseWork } =
      Promise.withResolvers<undefined>();
    const channel = createSlackIngress(trusted, async (turn, instanceId) => {
      turns.push(`${turn.text}:${instanceId}`);
      await blocked;
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bindings = testBindings(db);

    const threadedMention = event({ thread_ts: "170.root" });
    const first = await channel
      .route()
      .request(
        await signedRequest(threadedMention),
        undefined,
        bindings,
        executionCtx,
      );
    expect(first.status).toBe(200);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe("hello:slack:v1:T123:C123:170.root");
    releaseWork();
    await Promise.all(pending.splice(0));

    const duplicate = await channel
      .route()
      .request(
        await signedRequest(threadedMention),
        undefined,
        bindings,
        executionCtx,
      );
    expect(duplicate.status).toBe(200);
    await Promise.all(pending.splice(0));
    expect(turns).toHaveLength(1);

    const directMessage = {
      ...event(),
      event: {
        channel: "D123",
        channel_type: "im",
        text: "private hello",
        ts: "172.1",
        type: "message",
        user: "U123",
      },
      event_id: "Ev-private",
    };
    const directResponse = await channel
      .route()
      .request(
        await signedRequest(directMessage),
        undefined,
        bindings,
        executionCtx,
      );
    expect(directResponse.status).toBe(200);
    await Promise.all(pending);
    expect(turns.at(-1)).toBe("private hello:slack:v1:T123:D123:172.1");
  });

  test("rejects invalid signatures, mismatched identity, bots, subtypes, and empty turns", async () => {
    const db = new FakeD1();
    const admitted: string[] = [];
    const channel = createSlackIngress(trusted, (turn) => {
      admitted.push(turn.eventId);
      return Promise.resolve();
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bindings = testBindings(db);

    const invalid = await channel
      .route()
      .request("https://example.com/events", {
        body: JSON.stringify(event()),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    expect(invalid.status).toBe(401);

    const rejected = [
      { ...event(), event_id: "Ev-team", team_id: "T999" },
      { ...event(), api_app_id: "A999", event_id: "Ev-app" },
      event({ bot_id: "B123" }),
      {
        ...event(),
        event: {
          channel: "D1",
          channel_type: "im",
          subtype: "message_changed",
          text: "hello",
          ts: "1",
          type: "message",
          user: "U1",
        },
        event_id: "Ev-subtype",
      },
      event({ text: "<@UAPP>   " }),
      {
        ...event(),
        event: {
          channel: "D1",
          channel_type: "mpim",
          text: "hello",
          ts: "1",
          type: "message",
          user: "U1",
        },
        event_id: "Ev-im",
      },
    ];
    await Promise.all(
      rejected.map(async (payload) => {
        const response = await channel
          .route()
          .request(
            await signedRequest(payload),
            undefined,
            bindings,
            executionCtx,
          );
        expect(response.status).toBe(200);
      }),
    );
    await Promise.all(pending);
    expect(admitted).toEqual([]);
  });
});
