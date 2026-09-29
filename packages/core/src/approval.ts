import type { SlackBlockActionsPayload } from "@flue/slack";
import * as v from "valibot";
import type { ResolvedAgentConfig } from "./config.ts";
import { redact } from "./delivery.ts";
import type { ConversationSurface } from "./retention.ts";

export const APPROVAL_TTL_SECONDS = 600;
const APPROVAL_SWEEP_SECONDS = 7 * 24 * 60 * 60;
const APPROVAL_SWEEP_BATCH = 1000;
const APPROVAL_ARGUMENTS_LIMIT = 1500;
const APPROVE_ACTION = "approval_approve";
const REJECT_ACTION = "approval_reject";

export type ApprovalDecision = "approve" | "reject";
type ApprovalState = "pending" | "approved" | "rejected" | "executed";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonRpcId = string | number | null;

const jsonValue: v.GenericSchema<unknown, JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.number(),
    v.string(),
    v.array(jsonValue),
    v.record(v.string(), jsonValue),
  ]),
);

const jsonObject = v.record(v.string(), jsonValue);

export interface ApprovalRequest {
  readonly requestId: string;
  readonly conversationId: string;
  readonly teamId: string;
  readonly appId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly surface: ConversationSurface;
  readonly requesterId: string;
  readonly tool: string;
  readonly args: string;
  readonly state: ApprovalState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly messageTs: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const approvalRow = v.object({
  app_id: v.string(),
  args: v.string(),
  channel_id: v.string(),
  conversation_id: v.string(),
  created_at: v.number(),
  decided_at: v.nullable(v.number()),
  decided_by: v.nullable(v.string()),
  expires_at: v.number(),
  message_ts: v.nullable(v.string()),
  request_id: v.string(),
  requester_id: v.string(),
  state: v.picklist(["pending", "approved", "rejected", "executed"]),
  surface: v.picklist(["channel", "private"]),
  team_id: v.string(),
  thread_ts: v.string(),
  tool: v.string(),
});

const fromRow = (row: v.InferOutput<typeof approvalRow>): ApprovalRequest => ({
  appId: row.app_id,
  args: row.args,
  channelId: row.channel_id,
  conversationId: row.conversation_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  messageTs: row.message_ts ?? "",
  requestId: row.request_id,
  requesterId: row.requester_id,
  state: row.state,
  surface: row.surface,
  teamId: row.team_id,
  threadTs: row.thread_ts,
  tool: row.tool,
});

const SELECT_COLUMNS =
  "app_id, args, channel_id, conversation_id, created_at, decided_at, decided_by, expires_at, message_ts, request_id, requester_id, state, surface, team_id, thread_ts, tool";

const rowFrom = (results: readonly unknown[]): ApprovalRequest | undefined => {
  const [row] = results;
  return v.is(approvalRow, row) ? fromRow(row) : undefined;
};

export interface ApprovalStore {
  readonly read: (requestId: string) => Promise<ApprovalRequest | undefined>;
  readonly latest: (
    conversationId: string,
    tool: string,
    args: string,
  ) => Promise<ApprovalRequest | undefined>;
  readonly create: (request: ApprovalRequest) => Promise<void>;
  readonly attachMessage: (
    requestId: string,
    messageTs: string,
  ) => Promise<void>;
  readonly decide: (
    requestId: string,
    state: "approved" | "rejected",
    userId: string,
    now: number,
  ) => Promise<boolean>;
  readonly claim: (requestId: string) => Promise<boolean>;
}

const changes = (result: D1Result): number => result.meta.changes ?? 0;

export const createApprovalStore = (db: D1Database): ApprovalStore => ({
  async attachMessage(requestId, messageTs) {
    await db
      .prepare(
        "UPDATE approval_requests SET message_ts = ?1 WHERE request_id = ?2",
      )
      .bind(messageTs, requestId)
      .run();
  },
  async claim(requestId) {
    const result = await db
      .prepare(
        "UPDATE approval_requests SET state = 'executed' WHERE request_id = ?1 AND state = 'approved'",
      )
      .bind(requestId)
      .run();
    return changes(result) === 1;
  },
  async create(request) {
    await db
      .prepare(
        `INSERT INTO approval_requests (request_id, conversation_id, team_id, app_id, channel_id, thread_ts, surface, requester_id, tool, args, state, created_at, expires_at, message_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        request.requestId,
        request.conversationId,
        request.teamId,
        request.appId,
        request.channelId,
        request.threadTs,
        request.surface,
        request.requesterId,
        request.tool,
        request.args,
        request.state,
        request.createdAt,
        request.expiresAt,
        request.messageTs,
      )
      .run();
    try {
      await db
        .prepare(
          "DELETE FROM approval_requests WHERE rowid IN (SELECT rowid FROM approval_requests WHERE expires_at < ?1 LIMIT ?2)",
        )
        .bind(request.createdAt - APPROVAL_SWEEP_SECONDS, APPROVAL_SWEEP_BATCH)
        .run();
    } catch (error) {
      // The request is already stored; failing the call here would hide the
      // approval it just asked for behind a retention problem.
      console.error("approval_requests retention sweep failed", error);
    }
  },
  async decide(requestId, state, userId, now) {
    const result = await db
      .prepare(
        "UPDATE approval_requests SET state = ?1, decided_at = ?2, decided_by = ?3 WHERE request_id = ?4 AND state = 'pending'",
      )
      .bind(state, now, userId, requestId)
      .run();
    return changes(result) === 1;
  },
  async latest(conversationId, tool, args) {
    const { results } = await db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM approval_requests WHERE conversation_id = ?1 AND tool = ?2 AND args = ?3 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .bind(conversationId, tool, args)
      .all();
    return rowFrom(results);
  },
  async read(requestId) {
    const { results } = await db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM approval_requests WHERE request_id = ?1`,
      )
      .bind(requestId)
      .all();
    return rowFrom(results);
  },
});

const slackResponse = v.object({
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
  ts: v.optional(v.string()),
});

export interface ApprovalNotifier {
  readonly post: (request: ApprovalRequest) => Promise<string>;
  readonly settle: (request: ApprovalRequest, note: string) => Promise<void>;
}

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

interface SlackText {
  readonly text: string;
  readonly type: "mrkdwn" | "plain_text";
}

interface SlackButton {
  readonly action_id: string;
  readonly style: "primary" | "danger";
  readonly text: SlackText;
  readonly type: "button";
  readonly value: string;
}

type ApprovalBlock =
  | { readonly text: SlackText; readonly type: "section" }
  | { readonly elements: readonly SlackButton[]; readonly type: "actions" }
  | {
      readonly elements: readonly SlackText[];
      readonly type: "context";
    };

const approvalBlocks = (
  request: ApprovalRequest,
  note?: string,
): ApprovalBlock[] => [
  {
    text: {
      text: `*Approval required* — \`${request.tool}\` requested by <@${request.requesterId}>`,
      type: "mrkdwn",
    },
    type: "section",
  },
  {
    text: {
      text: clip(redact(request.args).trim(), APPROVAL_ARGUMENTS_LIMIT),
      type: "mrkdwn",
    },
    type: "section",
  },
  note === undefined
    ? {
        elements: [
          {
            action_id: APPROVE_ACTION,
            style: "primary",
            text: { text: "Approve", type: "plain_text" },
            type: "button",
            value: request.requestId,
          },
          {
            action_id: REJECT_ACTION,
            style: "danger",
            text: { text: "Reject", type: "plain_text" },
            type: "button",
            value: request.requestId,
          },
        ],
        type: "actions",
      }
    : {
        elements: [{ text: note, type: "mrkdwn" }],
        type: "context",
      },
];

interface SlackCallBody {
  readonly blocks: readonly ApprovalBlock[];
  readonly channel: string;
  readonly text: string;
  readonly thread_ts?: string;
  readonly ts?: string;
}

export const createApprovalNotifier = (
  token: string,
  fetcher: Fetcher = fetch,
): ApprovalNotifier => {
  const call = async (method: string, body: SlackCallBody): Promise<string> => {
    const response = await fetcher(`https://slack.com/api/${method}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
    });
    const result = v.parse(slackResponse, await response.json());
    if (result.ok !== true) {
      throw new Error(
        `Slack ${method} failed: ${result.error ?? response.status}`,
      );
    }
    return result.ts ?? "";
  };
  return {
    post: (request) =>
      call("chat.postMessage", {
        blocks: approvalBlocks(request),
        channel: request.channelId,
        text: `Approval required for ${request.tool}`,
        thread_ts: request.threadTs,
      }),
    async settle(request, note) {
      if (request.messageTs === "") {
        return;
      }
      await call("chat.update", {
        blocks: approvalBlocks(request, note),
        channel: request.channelId,
        text: note,
        ts: request.messageTs,
      });
    },
  };
};

export interface ApprovalGateContext {
  readonly conversationId: string;
  readonly teamId: string;
  readonly appId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly surface: ConversationSurface;
  readonly requesterId: string;
}

const REFUSAL_PENDING =
  "This call requires human approval: an Approve/Reject request for exactly this call is open in the Slack thread and nothing has been executed. Tell the user you are waiting for a person to approve it, and do not call this tool again until the approval arrives.";
const REFUSAL_REJECTED =
  "The operator rejected exactly this call, so it was not executed. Tell the user it was rejected and do not call it again.";
const REFUSAL_EXECUTED =
  "Exactly this call was already approved and executed. Do not repeat it.";
const REFUSAL_NO_THREAD =
  "This call requires human approval, but this conversation has no Slack thread to ask in, so it was not executed.";

const refusalText = (state: ApprovalState): string => {
  if (state === "rejected") {
    return REFUSAL_REJECTED;
  }
  return state === "executed" ? REFUSAL_EXECUTED : REFUSAL_PENDING;
};

const toolCallMessage = v.object({
  id: v.optional(v.union([v.string(), v.number(), v.null()]), null),
  method: v.literal("tools/call"),
  params: v.object({
    arguments: v.optional(jsonValue, null),
    name: v.string(),
  }),
});

interface McpToolCall {
  readonly id: JsonRpcId;
  readonly name: string;
  readonly args: JsonValue;
}

interface ParsedMcpBody {
  readonly batch: boolean;
  readonly calls: readonly McpToolCall[];
}

const toolCallsOf = (entries: readonly JsonValue[]): McpToolCall[] =>
  entries.flatMap((entry) => {
    const parsed = v.safeParse(toolCallMessage, entry);
    return parsed.success
      ? [
          {
            args: parsed.output.params.arguments,
            id: parsed.output.id,
            name: parsed.output.params.name,
          },
        ]
      : [];
  });

// The transport hands the JSON-RPC request over as a string body.
const parseMcpBody = (
  body: BodyInit | null | undefined,
): ParsedMcpBody | undefined => {
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), jsonValue),
    body,
  );
  if (!parsed.success) {
    return undefined;
  }
  if (Array.isArray(parsed.output)) {
    return { batch: true, calls: toolCallsOf(parsed.output) };
  }
  return { batch: false, calls: toolCallsOf([parsed.output]) };
};

export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (v.is(jsonObject, value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) =>
      left < right ? -1 : Number(left > right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const refusalResponse = (text: string, id: JsonRpcId): Response =>
  Response.json(
    {
      id,
      jsonrpc: "2.0",
      result: { content: [{ text, type: "text" }], isError: true },
    },
    { headers: { "content-type": "application/json" } },
  );

export interface ApprovalGateOptions {
  readonly store: ApprovalStore;
  readonly notifier: ApprovalNotifier;
  readonly context: () => ApprovalGateContext | undefined;
  readonly gated: (tool: string) => boolean;
  readonly fetch?: Fetcher;
  readonly now?: () => number;
  readonly newRequestId?: () => string;
}

export const createApprovalFetch = (options: ApprovalGateOptions): Fetcher => {
  const base = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
  return async (input, init) => {
    const body = parseMcpBody(init?.body);
    const call = body?.calls.find((entry) => options.gated(entry.name));
    if (body === undefined || call === undefined) {
      return await base(input, init);
    }
    // An approval binds one call; a batch would let a call ride along unbound.
    if (body.batch) {
      return new Response("Gated MCP calls are not accepted in a batch", {
        status: 400,
      });
    }
    const context = options.context();
    if (context === undefined) {
      return refusalResponse(REFUSAL_NO_THREAD, call.id);
    }
    const timestamp = now();
    const args = canonicalJson(call.args);
    const existing = await options.store.latest(
      context.conversationId,
      call.name,
      args,
    );
    if (existing !== undefined && existing.expiresAt > timestamp) {
      if (existing.state !== "approved") {
        return refusalResponse(refusalText(existing.state), call.id);
      }
      const claimed = await options.store.claim(existing.requestId);
      return claimed
        ? await base(input, init)
        : refusalResponse(REFUSAL_EXECUTED, call.id);
    }
    const request: ApprovalRequest = {
      appId: context.appId,
      args,
      channelId: context.channelId,
      conversationId: context.conversationId,
      createdAt: timestamp,
      expiresAt: timestamp + APPROVAL_TTL_SECONDS,
      messageTs: "",
      requestId: newRequestId(),
      requesterId: context.requesterId,
      state: "pending",
      surface: context.surface,
      teamId: context.teamId,
      threadTs: context.threadTs,
      tool: call.name,
    };
    await options.store.create(request);
    await options.store.attachMessage(
      request.requestId,
      await options.notifier.post(request),
    );
    return refusalResponse(REFUSAL_PENDING, call.id);
  };
};

const interaction = v.object({
  actions: v.array(
    v.object({
      action_id: v.string(),
      value: v.optional(v.string()),
    }),
  ),
  channel: v.optional(v.object({ id: v.optional(v.string()) })),
  container: v.optional(v.object({ thread_ts: v.optional(v.string()) })),
  message: v.optional(
    v.object({
      thread_ts: v.optional(v.string()),
      ts: v.optional(v.string()),
    }),
  ),
  type: v.literal("block_actions"),
  user: v.object({ id: v.string() }),
});

const decidedInteraction = (
  payload: SlackBlockActionsPayload,
):
  | {
      readonly decision: ApprovalDecision;
      readonly requestId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly userId: string;
    }
  | undefined => {
  const parsed = v.safeParse(interaction, payload);
  if (!parsed.success) {
    return undefined;
  }
  const action = parsed.output.actions.find(
    (entry) =>
      (entry.action_id === APPROVE_ACTION ||
        entry.action_id === REJECT_ACTION) &&
      (entry.value ?? "") !== "",
  );
  const channelId = parsed.output.channel?.id ?? "";
  const threadTs =
    parsed.output.message?.thread_ts ??
    parsed.output.container?.thread_ts ??
    parsed.output.message?.ts ??
    "";
  if (action === undefined || !(channelId && threadTs)) {
    return undefined;
  }
  return {
    channelId,
    decision: action.action_id === APPROVE_ACTION ? "approve" : "reject",
    requestId: action.value ?? "",
    threadTs,
    userId: parsed.output.user.id,
  };
};

const APPROVED_NOTE =
  "Approved. The agent is running this call now; nothing was executed before this decision.";
const REJECTED_NOTE = "Rejected. Nothing was executed.";
const EXPIRED_NOTE =
  "Expired without a decision. Nothing was executed; ask again for a fresh approval.";

export interface ApprovalInteractionOptions {
  readonly store: ApprovalStore;
  readonly notifier: ApprovalNotifier;
  readonly decide: (
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ) => Promise<void>;
  readonly now?: () => number;
}

export const handleApprovalInteraction = async (
  payload: SlackBlockActionsPayload,
  options: ApprovalInteractionOptions,
): Promise<void> => {
  const decided = decidedInteraction(payload);
  if (decided === undefined) {
    return;
  }
  const request = await options.store.read(decided.requestId);
  if (
    request === undefined ||
    request.state !== "pending" ||
    request.channelId !== decided.channelId ||
    request.threadTs !== decided.threadTs ||
    request.requesterId !== decided.userId
  ) {
    return;
  }
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (request.expiresAt <= now) {
    await options.notifier.settle(request, EXPIRED_NOTE);
    return;
  }
  await options.decide(request, decided.decision);
  const claimed = await options.store.decide(
    request.requestId,
    decided.decision === "approve" ? "approved" : "rejected",
    decided.userId,
    now,
  );
  if (claimed) {
    await options.notifier.settle(
      request,
      decided.decision === "approve" ? APPROVED_NOTE : REJECTED_NOTE,
    );
  }
};

export const approvalInstructions = (
  config: ResolvedAgentConfig,
): readonly string[] =>
  Object.freeze(
    config.mcpServers.flatMap(({ name, requireApproval }) =>
      (requireApproval ?? []).map(
        (tool) =>
          `Calling mcp__${name}__${tool} requires human approval: the call executes nothing until a person approves it in Slack, and an approved call runs only when you repeat it with exactly the same arguments.`,
      ),
    ),
  );
