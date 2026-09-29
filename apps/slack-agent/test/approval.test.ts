import { describe, expect, test } from "bun:test";
import {
  APPROVAL_TTL_SECONDS,
  canonicalJson,
  createApprovalFetch,
  createApprovalNotifier,
  handleApprovalInteraction,
} from "@agentic-slack/core";
import type {
  ApprovalDecision,
  ApprovalGateContext,
  ApprovalNotifier,
  ApprovalRequest,
  ApprovalStore,
  SlackBlockActionsPayload,
} from "@agentic-slack/core";
import * as v from "valibot";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type MutableRequest = {
  -readonly [K in keyof ApprovalRequest]: ApprovalRequest[K];
};

const NOW = 1_700_000_000;
const CONVERSATION = "slack:v1:T1:D1:D1";
const GATED = "create_organization";

const PENDING_TEXT =
  "This call requires human approval: an Approve/Reject request for exactly this call is open in the Slack thread and nothing has been executed. Tell the user you are waiting for a person to approve it, and do not call this tool again until the approval arrives.";
const REJECTED_TEXT =
  "The operator rejected exactly this call, so it was not executed. Tell the user it was rejected and do not call it again.";
const EXECUTED_TEXT =
  "Exactly this call was already approved and executed. Do not repeat it.";
const NO_THREAD_TEXT =
  "This call requires human approval, but this conversation has no Slack thread to ask in, so it was not executed.";
const APPROVED_NOTE =
  "Approved. The agent is running this call now; nothing was executed before this decision.";
const REJECTED_NOTE = "Rejected. Nothing was executed.";
const EXPIRED_NOTE =
  "Expired without a decision. Nothing was executed; ask again for a fresh approval.";

const contexts = new Map<string, ApprovalGateContext>([
  [
    CONVERSATION,
    {
      appId: "A1",
      channelId: "D1",
      conversationId: CONVERSATION,
      requesterId: "U1",
      surface: "private",
      teamId: "T1",
      threadTs: "171.1",
    },
  ],
]);

const memoryStore = () => {
  const rows: MutableRequest[] = [];
  const find = (requestId: string) =>
    rows.find((row) => row.requestId === requestId);
  const store: ApprovalStore = {
    attachMessage(requestId, messageTs) {
      const row = find(requestId);
      if (row !== undefined) {
        row.messageTs = messageTs;
      }
      return Promise.resolve();
    },
    claim(requestId) {
      const row = find(requestId);
      if (row?.state !== "approved") {
        return Promise.resolve(false);
      }
      row.state = "executed";
      return Promise.resolve(true);
    },
    create(request) {
      rows.push({ ...request });
      return Promise.resolve();
    },
    decide(requestId, state) {
      const row = find(requestId);
      if (row?.state !== "pending") {
        return Promise.resolve(false);
      }
      row.state = state;
      return Promise.resolve(true);
    },
    latest(conversationId, tool, args) {
      return Promise.resolve(
        rows.findLast(
          (row) =>
            row.conversationId === conversationId &&
            row.tool === tool &&
            row.args === args,
        ),
      );
    },
    read(requestId) {
      return Promise.resolve(find(requestId));
    },
  };
  return { rows, store };
};

const recordingNotifier = () => {
  const posts: ApprovalRequest[] = [];
  const settled: { note: string; requestId: string }[] = [];
  const notifier: ApprovalNotifier = {
    post(request) {
      posts.push({ ...request });
      return Promise.resolve("171.2");
    },
    settle(request, note) {
      settled.push({ note, requestId: request.requestId });
      return Promise.resolve();
    },
  };
  return { notifier, posts, settled };
};

const recordingFetch = () => {
  const calls: { body: string; url: string }[] = [];
  const fetch: Fetcher = (input, init) => {
    calls.push({
      body: v.parse(v.optional(v.string()), init?.body) ?? "",
      url: v.parse(v.string(), input),
    });
    return Promise.resolve(Response.json({ ok: true }));
  };
  return { calls, fetch };
};

const toolCall = (
  name: string,
  args: Readonly<Record<string, number | string>>,
  id = 7,
): string =>
  JSON.stringify({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: args, name },
  });

const gateFor = (options: { conversation?: string } = {}) => {
  let now = NOW;
  let requests = 0;
  const { calls, fetch } = recordingFetch();
  const { notifier, posts, settled } = recordingNotifier();
  const { rows, store } = memoryStore();
  return {
    calls,
    gate: createApprovalFetch({
      context: () => contexts.get(options.conversation ?? CONVERSATION),
      fetch,
      gated: (tool) => tool === GATED,
      newRequestId: () => `req-${(requests += 1)}`,
      notifier,
      now: () => now,
      store,
    }),
    posts,
    rows,
    setNow: (value: number) => {
      now = value;
    },
    settled,
    store,
  };
};

const call = (
  gate: Fetcher,
  body: string,
  url = "https://mcp.test/mcp",
): Promise<Response> => gate(url, { body, method: "POST" });

describe("approval gate", () => {
  test("never reaches the MCP server before a person approves the call", async () => {
    const { calls, gate, posts, rows } = gateFor();

    const response = await call(gate, toolCall(GATED, { domain: "acme.test" }));

    expect(calls).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(rows).toEqual([
      {
        appId: "A1",
        args: '{"domain":"acme.test"}',
        channelId: "D1",
        conversationId: CONVERSATION,
        createdAt: NOW,
        expiresAt: NOW + APPROVAL_TTL_SECONDS,
        messageTs: "171.2",
        requestId: "req-1",
        requesterId: "U1",
        state: "pending",
        surface: "private",
        teamId: "T1",
        threadTs: "171.1",
        tool: GATED,
      },
    ]);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      id: 7,
      jsonrpc: "2.0",
      result: {
        content: [{ text: PENDING_TEXT, type: "text" }],
        isError: true,
      },
    });
  });

  test("treats the same call with reordered arguments as the open request", async () => {
    const { calls, gate, posts } = gateFor();
    // Insertion order survives serialization, so this reaches the gate as the
    // same call with its arguments written in the other order.
    const reordered = Object.fromEntries<string | number>([
      ["seats", 3],
      ["domain", "acme.test"],
    ]);

    await call(gate, toolCall(GATED, { domain: "acme.test", seats: 3 }));
    const response = await call(gate, toolCall(GATED, reordered, 8));

    expect(calls).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(await response.json()).toEqual({
      id: 8,
      jsonrpc: "2.0",
      result: {
        content: [{ text: PENDING_TEXT, type: "text" }],
        isError: true,
      },
    });
  });

  test("forwards exactly one approved call and refuses the replay", async () => {
    const { calls, gate, rows, store } = gateFor();
    const body = toolCall(GATED, { domain: "acme.test" });

    await call(gate, body);
    expect(await store.decide("req-1", "approved", "U1", NOW)).toBe(true);

    expect(await call(gate, body)).toMatchObject({ status: 200 });
    expect(calls).toEqual([{ body, url: "https://mcp.test/mcp" }]);
    expect(rows[0]?.state).toBe("executed");

    const replay = await call(gate, body);
    expect(calls).toHaveLength(1);
    expect(await replay.json()).toEqual({
      id: 7,
      jsonrpc: "2.0",
      result: {
        content: [{ text: EXECUTED_TEXT, type: "text" }],
        isError: true,
      },
    });
  });

  test("never forwards a rejected call and does not ask again", async () => {
    const { calls, gate, posts, rows, store } = gateFor();

    await call(gate, toolCall(GATED, { domain: "acme.test" }));
    expect(await store.decide("req-1", "rejected", "U1", NOW)).toBe(true);

    const response = await call(gate, toolCall(GATED, { domain: "acme.test" }));

    expect(calls).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(await response.json()).toEqual({
      id: 7,
      jsonrpc: "2.0",
      result: {
        content: [{ text: REJECTED_TEXT, type: "text" }],
        isError: true,
      },
    });
  });

  test("never forwards an approval that expired, and asks again", async () => {
    const { calls, gate, posts, rows, setNow, store } = gateFor();

    await call(gate, toolCall(GATED, { domain: "acme.test" }));
    expect(await store.decide("req-1", "approved", "U1", NOW)).toBe(true);
    setNow(NOW + APPROVAL_TTL_SECONDS);

    const response = await call(gate, toolCall(GATED, { domain: "acme.test" }));

    expect(calls).toEqual([]);
    expect(posts).toHaveLength(2);
    expect(rows.map((row) => row.state)).toEqual(["approved", "pending"]);
    expect(await response.json()).toEqual({
      id: 7,
      jsonrpc: "2.0",
      result: {
        content: [{ text: PENDING_TEXT, type: "text" }],
        isError: true,
      },
    });
  });

  test("leaves every other MCP request on the connection alone", async () => {
    const { calls, gate, posts } = gateFor();
    const bodies = [
      toolCall("find_organization", { domain: "acme.test" }),
      JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "not json at all",
    ];

    for (const body of bodies) {
      // The connection's own traffic must not be gated or reshaped.
      // oxlint-disable-next-line no-await-in-loop
      await call(gate, body);
    }
    await gate("https://mcp.test/mcp", { method: "GET" });

    expect(calls.map((entry) => entry.body)).toEqual([...bodies, ""]);
    expect(posts).toEqual([]);
  });

  test("refuses a gated call riding in a JSON-RPC batch", async () => {
    const { calls, gate, posts } = gateFor();
    const batch = JSON.stringify([
      {
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: GATED },
      },
      { id: 2, jsonrpc: "2.0", method: "tools/list" },
    ]);

    const response = await call(gate, batch);

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    expect(posts).toEqual([]);
  });

  test("fails closed when the conversation has no thread to ask in", async () => {
    const { calls, gate, posts } = gateFor({
      conversation: "slack:v1:T1:D9:D9",
    });

    const response = await call(gate, toolCall(GATED, { domain: "acme.test" }));

    expect(calls).toEqual([]);
    expect(posts).toEqual([]);
    expect(await response.json()).toEqual({
      id: 7,
      jsonrpc: "2.0",
      result: {
        content: [{ text: NO_THREAD_TEXT, type: "text" }],
        isError: true,
      },
    });
  });
});

const blockActions = (overrides: {
  actionId?: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  value?: string;
}): SlackBlockActionsPayload => {
  const threadTs = overrides.threadTs ?? "171.1";
  return {
    actions: [
      {
        action_id: overrides.actionId ?? "approval_approve",
        block_id: "approval",
        type: "button",
        value: overrides.value ?? "req-1",
      },
    ],
    api_app_id: "A1",
    channel: { id: overrides.channelId ?? "D1" },
    container: { thread_ts: threadTs, type: "message" },
    message: { thread_ts: threadTs, ts: "171.2" },
    team: { id: "T1" },
    type: "block_actions",
    user: { id: overrides.userId ?? "U1" },
  };
};

const pendingRequest = (): ApprovalRequest => ({
  appId: "A1",
  args: '{"domain":"acme.test"}',
  channelId: "D1",
  conversationId: CONVERSATION,
  createdAt: NOW,
  expiresAt: NOW + APPROVAL_TTL_SECONDS,
  messageTs: "171.2",
  requestId: "req-1",
  requesterId: "U1",
  state: "pending",
  surface: "private",
  teamId: "T1",
  threadTs: "171.1",
  tool: GATED,
});

const interactionFor = (request: ApprovalRequest = pendingRequest()) => {
  const decisions: { decision: ApprovalDecision; requestId: string }[] = [];
  const { rows, store } = memoryStore();
  const { notifier, settled } = recordingNotifier();
  const seed = () => store.create(request);
  return {
    decide: (entry: ApprovalRequest, decision: ApprovalDecision) => {
      decisions.push({ decision, requestId: entry.requestId });
      return Promise.resolve();
    },
    decisions,
    handle: (payload: SlackBlockActionsPayload, now = NOW) =>
      handleApprovalInteraction(payload, {
        decide: (entry, decision) => {
          decisions.push({ decision, requestId: entry.requestId });
          return Promise.resolve();
        },
        notifier,
        now: () => now,
        store,
      }),
    rows,
    seed,
    settled,
    store,
  };
};

describe("approval interactions", () => {
  test("approves the requester's own pending call and reports it", async () => {
    const { decisions, handle, rows, seed, settled } = interactionFor();
    await seed();

    await handle(blockActions({}));

    expect(decisions).toEqual([{ decision: "approve", requestId: "req-1" }]);
    expect(rows[0]?.state).toBe("approved");
    expect(settled).toEqual([{ note: APPROVED_NOTE, requestId: "req-1" }]);
  });

  test("rejects the call and reports it", async () => {
    const { decisions, handle, rows, seed, settled } = interactionFor();
    await seed();

    await handle(blockActions({ actionId: "approval_reject" }));

    expect(decisions).toEqual([{ decision: "reject", requestId: "req-1" }]);
    expect(rows[0]?.state).toBe("rejected");
    expect(settled).toEqual([{ note: REJECTED_NOTE, requestId: "req-1" }]);
  });

  test("ignores a click from another user, another thread, or another request", async () => {
    const payloads = [
      blockActions({ userId: "U2" }),
      blockActions({ threadTs: "999.9" }),
      blockActions({ channelId: "D2" }),
      blockActions({ value: "req-unknown" }),
      blockActions({ actionId: "other_action" }),
    ];
    const ignored = await Promise.all(
      payloads.map(async (payload) => {
        const { decisions, handle, rows, seed, settled } = interactionFor();
        await seed();
        await handle(payload);
        return { decisions, rows, settled };
      }),
    );
    for (const outcome of ignored) {
      expect(outcome.decisions).toEqual([]);
      expect(outcome.rows[0]?.state).toBe("pending");
      expect(outcome.settled).toEqual([]);
    }
  });

  test("ignores a replayed decision", async () => {
    const { decisions, handle, rows, seed, settled } = interactionFor();
    await seed();

    await handle(blockActions({}));
    await handle(blockActions({ actionId: "approval_reject" }));

    expect(decisions).toEqual([{ decision: "approve", requestId: "req-1" }]);
    expect(rows[0]?.state).toBe("approved");
    expect(settled).toHaveLength(1);
  });

  test("ignores a decision that arrived after the request expired", async () => {
    const { decisions, handle, rows, seed, settled } = interactionFor();
    await seed();

    await handle(blockActions({}), NOW + APPROVAL_TTL_SECONDS);

    expect(decisions).toEqual([]);
    expect(rows[0]?.state).toBe("pending");
    expect(settled).toEqual([{ note: EXPIRED_NOTE, requestId: "req-1" }]);
  });
});

const notifierRequests = () => {
  const requests: {
    authorization: string | null;
    body: unknown;
    method: string;
    url: string;
  }[] = [];
  const notifier = createApprovalNotifier(
    "xoxb-approval-token",
    async (input, init) => {
      const request = new Request(v.parse(v.string(), input), init);
      requests.push({
        authorization: request.headers.get("authorization"),
        body: await request.json(),
        method: request.method,
        url: request.url,
      });
      return Response.json({ ok: true, ts: "171.3" });
    },
  );
  return { notifier, requests };
};

describe("approval card", () => {
  test("posts the exact call as an Approve/Reject card in the requesting thread", async () => {
    const { notifier, requests } = notifierRequests();
    const request = {
      ...pendingRequest(),
      args: '<!channel> {"domain":"acme.test"}',
    };

    expect(await notifier.post(request)).toBe("171.3");

    expect(requests).toEqual([
      {
        authorization: "Bearer xoxb-approval-token",
        body: {
          blocks: [
            {
              text: {
                text: "*Approval required* — `create_organization` requested by <@U1>",
                type: "mrkdwn",
              },
              type: "section",
            },
            {
              text: { text: '{"domain":"acme.test"}', type: "mrkdwn" },
              type: "section",
            },
            {
              elements: [
                {
                  action_id: "approval_approve",
                  style: "primary",
                  text: { text: "Approve", type: "plain_text" },
                  type: "button",
                  value: "req-1",
                },
                {
                  action_id: "approval_reject",
                  style: "danger",
                  text: { text: "Reject", type: "plain_text" },
                  type: "button",
                  value: "req-1",
                },
              ],
              type: "actions",
            },
          ],
          channel: "D1",
          text: "Approval required for create_organization",
          thread_ts: "171.1",
        },
        method: "POST",
        url: "https://slack.com/api/chat.postMessage",
      },
    ]);
  });

  test("replaces the buttons with the outcome", async () => {
    const { notifier, requests } = notifierRequests();

    await notifier.settle(pendingRequest(), APPROVED_NOTE);

    expect(requests).toEqual([
      {
        authorization: "Bearer xoxb-approval-token",
        body: {
          blocks: [
            {
              text: {
                text: "*Approval required* — `create_organization` requested by <@U1>",
                type: "mrkdwn",
              },
              type: "section",
            },
            {
              text: { text: '{"domain":"acme.test"}', type: "mrkdwn" },
              type: "section",
            },
            {
              elements: [{ text: APPROVED_NOTE, type: "mrkdwn" }],
              type: "context",
            },
          ],
          channel: "D1",
          text: APPROVED_NOTE,
          ts: "171.2",
        },
        method: "POST",
        url: "https://slack.com/api/chat.update",
      },
    ]);
  });

  test("raises the Slack error when the card is rejected", async () => {
    const notifier = createApprovalNotifier("xoxb-test", () =>
      Promise.resolve(Response.json({ error: "not_in_channel", ok: false })),
    );
    let failure = "resolved";
    try {
      await notifier.post(pendingRequest());
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : "unknown";
    }
    expect(failure).toBe("Slack chat.postMessage failed: not_in_channel");
  });
});

test("canonicalizes the arguments a card shows", () => {
  expect(canonicalJson({ a: { c: 2, d: 1 }, b: [2, 1] })).toBe(
    '{"a":{"c":2,"d":1},"b":[2,1]}',
  );
  expect(v.is(v.string(), canonicalJson(null))).toBe(true);
});
