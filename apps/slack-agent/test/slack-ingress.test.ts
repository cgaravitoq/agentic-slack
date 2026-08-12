import { describe, expect, test } from "bun:test";
import {
  createSlackIngress,
  type SlackCoreBindings,
} from "@agentic-slack/core";

const trusted = {
  signingSecret: "signing-secret-for-tests-1234567890",
  botToken: "xoxb-test",
  teamId: "T123",
  appId: "A123",
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
      run: async () => {
        const eventId = String(this.values[0]);
        if (sql.startsWith("INSERT")) {
          if (this.seen.has(eventId)) return { meta: { changes: 0 } };
          this.seen.add(eventId);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM seen_events WHERE event_id"))
          this.seen.delete(eventId);
        return { meta: { changes: 1 } };
      },
    };
  }
}

async function signedRequest(payload: object): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(trusted.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
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
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A123",
    event_id: "Ev123",
    event: {
      type: "app_mention",
      channel: "C123",
      ts: "171.1",
      user: "U123",
      text: "<@UAPP> hello",
      ...overrides,
    },
  };
}

describe("signed Slack ingress", () => {
  test("acks before work and deduplicates all side effects by event_id", async () => {
    const db = new FakeD1();
    const turns: string[] = [];
    let releaseWork: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const channel = createSlackIngress(trusted, async (turn, instanceId) => {
      turns.push(`${turn.text}:${instanceId}`);
      await blocked;
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const bindings = {
      DB: db as unknown as D1Database,
      FLUE_SLACK_AGENT_AGENT: {},
      AI: {},
    } as unknown as SlackCoreBindings;

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
    releaseWork?.();
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
      event_id: "Ev-private",
      event: {
        type: "message",
        channel: "D123",
        channel_type: "im",
        ts: "172.1",
        user: "U123",
        text: "private hello",
      },
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
    const channel = createSlackIngress(trusted, async (turn) => {
      admitted.push(turn.eventId);
    });
    const pending: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const bindings = {
      DB: db as unknown as D1Database,
      FLUE_SLACK_AGENT_AGENT: {},
      AI: {},
    } as unknown as SlackCoreBindings;

    const invalid = await channel
      .route()
      .request("https://example.com/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event()),
      });
    expect(invalid.status).toBe(401);

    const rejected = [
      { ...event(), team_id: "T999", event_id: "Ev-team" },
      { ...event(), api_app_id: "A999", event_id: "Ev-app" },
      event({ bot_id: "B123" }),
      {
        ...event(),
        event_id: "Ev-subtype",
        event: {
          type: "message",
          channel: "D1",
          channel_type: "im",
          subtype: "message_changed",
          ts: "1",
          user: "U1",
          text: "hello",
        },
      },
      event({ text: "<@UAPP>   " }),
      {
        ...event(),
        event_id: "Ev-im",
        event: {
          type: "message",
          channel: "D1",
          channel_type: "mpim",
          ts: "1",
          user: "U1",
          text: "hello",
        },
      },
    ];
    for (const payload of rejected) {
      const response = await channel
        .route()
        .request(
          await signedRequest(payload),
          undefined,
          bindings,
          executionCtx,
        );
      expect(response.status).toBe(200);
    }
    await Promise.all(pending);
    expect(admitted).toEqual([]);
  });
});
