import { timingSafeEqual } from "node:crypto";
import { defineTool } from "@flue/runtime";
import type { SlackBlockActionsPayload } from "@flue/slack";
import * as v from "valibot";
import { createSqlSlackChannelAdmissionStore } from "./admission.ts";
import type { DelegationConfig } from "./config.ts";
import { createDelegationStore, runnerSchema } from "./delegation-store.ts";
import type {
  DelegationRunner,
  DelegationTask,
  StoredDelegationTask,
} from "./delegation-store.ts";
import { redact } from "./delivery.ts";
import { readRawSlackThread } from "./read.ts";
import type { SlackReadBinding } from "./read.ts";

export interface DelegationOptions {
  db: D1Database;
  bearer: string;
  botToken: string;
  runnerHeaders: Readonly<Record<string, string>>;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  schedule: (instanceId: string, task: DelegationTask) => Promise<void>;
  cancelSchedule: (instanceId: string, taskId: string) => Promise<void>;
  waitUntil: (work: Promise<void>) => void;
}
const errorAnswer = (status: number, error: string): Response =>
  Response.json({ error, ok: false }, { status });
const requestBody = async <T extends v.GenericSchema>(
  request: Request,
  schema: T,
) => {
  try {
    return v.safeParse(schema, await request.json());
  } catch {
    return v.safeParse(schema, null);
  }
};
const runnerInput = v.object({ runner: v.pipe(v.string(), v.nonEmpty()) });
const stateInput = v.object({
  ...runnerInput.entries,
  note: v.optional(v.pipe(v.string(), v.maxLength(500))),
  state: v.picklist(["running", "failed", "unknown"]),
});
const interactionSchema = v.object({
  actions: v.array(
    v.object({ action_id: v.string(), value: v.optional(v.string()) }),
  ),
  channel: v.optional(v.object({ id: v.string() })),
  container: v.optional(v.object({ thread_ts: v.optional(v.string()) })),
  message: v.optional(
    v.object({ thread_ts: v.optional(v.string()), ts: v.optional(v.string()) }),
  ),
  user: v.object({ id: v.string() }),
});
const decisionValue = v.object({
  id: v.string(),
  runner: v.optional(v.string()),
});
const alreadyHolds = (
  stored: StoredDelegationTask | undefined,
  runner: string,
  state: string,
): boolean =>
  stored !== undefined &&
  stored.runner === runner &&
  stored.task.state === state;
const proposalInput = (repos: readonly string[]) =>
  v.object({
    channel: v.optional(v.string()),
    repo: v.picklist([...repos]),
    summary: v.pipe(v.string(), v.nonEmpty()),
    threadTs: v.optional(v.pipe(v.string(), v.regex(/^\d+\.\d+$/u))),
  });

export const createDelegation = (
  config: DelegationConfig,
  options: DelegationOptions,
) => {
  const store = createDelegationStore(options.db);
  const fetcher = options.fetcher ?? fetch;
  const proposal = proposalInput(config.repos);
  const proposalDescription = `Propose delegation only when the requester explicitly asks. Capture the bound thread and request their approval for a configured repo and runner. The configured repos are ${config.repos.join(", ")}. In an owner's DM, supply an admitted channel and threadTs.`;
  const slack = async (
    task: DelegationTask,
    text: string,
    blocks?: readonly unknown[],
  ): Promise<void> => {
    const response = await fetcher("https://slack.com/api/chat.postMessage", {
      body: JSON.stringify({
        blocks,
        channel: task.channel,
        text,
        thread_ts: task.threadTs,
      }),
      headers: {
        authorization: `Bearer ${options.botToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const result = v.parse(
      v.object({ ok: v.boolean() }),
      await response.json(),
    );
    if (!response.ok || !result.ok) {
      throw new Error("Slack delegation message failed");
    }
  };
  const notify = async (task: DelegationTask, text: string): Promise<void> => {
    try {
      await slack(task, text);
    } catch (error: unknown) {
      console.error("Slack delegation notice failed", error);
    }
  };
  const runnerRequest = (
    runner: DelegationRunner,
    path: string,
    task?: DelegationTask,
  ): Promise<Response> =>
    fetcher(new URL(path, runner.url), {
      body: task === undefined ? undefined : JSON.stringify({ task }),
      headers: {
        ...options.runnerHeaders,
        authorization: `Bearer ${options.bearer}`,
        "content-type": "application/json",
      },
      method: task === undefined ? "GET" : "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  const queued = async (task: DelegationTask): Promise<void> => {
    const current = await store.read(task.id);
    if (current?.task.state === "approved") {
      await slack(task, "Queued until the runner is back.");
    }
  };
  const dispatch = async (
    task: DelegationTask,
    runner: DelegationRunner,
  ): Promise<void> => {
    try {
      const response = await runnerRequest(runner, "/tasks", task);
      if (response.status === 202) {
        const result = v.safeParse(
          v.object({ ok: v.literal(true) }),
          await response.json(),
        );
        if (result.success) {
          return;
        }
      }
    } catch {
      await queued(task);
      return;
    }
    await queued(task);
  };
  const cancel = async (stored: StoredDelegationTask): Promise<void> => {
    await options.cancelSchedule(stored.instanceId, stored.task.id);
  };
  const handleTaskRequest = async (
    request: Request,
    url: URL,
    id: string,
    action: string | undefined,
  ): Promise<Response> => {
    if (action === undefined && request.method === "GET") {
      const runner = url.searchParams.get("runner");
      if (runner === null || runner === "") {
        return errorAnswer(400, "invalid_request");
      }
      const stored = await store.read(id);
      return stored !== undefined && stored.runner === runner
        ? Response.json({ ok: true, task: stored.task })
        : errorAnswer(404, "not_found");
    }
    if (action === "claim" && request.method === "POST") {
      const input = await requestBody(request, runnerInput);
      if (!input.success) {
        return errorAnswer(400, "invalid_request");
      }
      const claimed = await store.claim(id, input.output.runner);
      if (claimed === undefined) {
        return errorAnswer(409, "not_claimable");
      }
      await options.cancelSchedule(claimed.instanceId, id);
      return Response.json({
        ok: true,
        task: claimed.task,
        token: claimed.token,
      });
    }
    if (action === "state" && request.method === "POST") {
      const input = await requestBody(request, stateInput);
      if (!input.success) {
        return errorAnswer(400, "invalid_request");
      }
      const changed = await store.transition(
        id,
        input.output.runner,
        input.output.state,
      );
      const stored = await store.read(id);
      if (
        !changed &&
        !alreadyHolds(stored, input.output.runner, input.output.state)
      ) {
        return errorAnswer(409, "invalid_transition");
      }
      if (changed && stored !== undefined) {
        options.waitUntil(
          notify(
            stored.task,
            `${{ failed: "Failed", running: "Started", unknown: "Outcome unknown" }[input.output.state]}.${input.output.note === undefined ? "" : ` ${redact(input.output.note)}`}`,
          ),
        );
      }
      return Response.json({ ok: true });
    }
    return errorAnswer(404, "not_found");
  };
  return {
    cancelExpiry: cancel,
    async expire(id: string): Promise<void> {
      if (await store.expire(id)) {
        const stored = await store.read(id);
        if (stored !== undefined) {
          options.waitUntil(
            notify(stored.task, "Task expired after 24 hours without a claim."),
          );
        }
      }
    },
    async handle(request: Request): Promise<Response> {
      const supplied = new TextEncoder().encode(
        request.headers.get("authorization") ?? "",
      );
      const expected = new TextEncoder().encode(`Bearer ${options.bearer}`);
      if (
        !options.bearer ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        const taskToken = await store.tokenTask(
          /^Bearer (?<token>[A-Za-z0-9_-]+)$/u.exec(
            request.headers.get("authorization") ?? "",
          )?.groups?.token ?? "",
        );
        return taskToken === undefined
          ? errorAnswer(401, "unauthorized")
          : errorAnswer(403, "token_scope");
      }
      const url = new URL(request.url);
      if (url.pathname === "/delegation/runners" && request.method === "POST") {
        const input = await requestBody(request, runnerSchema);
        if (!input.success) {
          return errorAnswer(400, "invalid_request");
        }
        await store.register(input.output);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/delegation/tasks" && request.method === "GET") {
        const runner = url.searchParams.get("runner");
        if (runner === null || runner === "") {
          return errorAnswer(400, "invalid_request");
        }
        return Response.json({ ok: true, tasks: await store.approved(runner) });
      }
      const match =
        /^\/delegation\/tasks\/(?<id>[^/]+)(?:\/(?<action>claim|state))?$/u.exec(
          url.pathname,
        );
      if (match === null) {
        return errorAnswer(404, "not_found");
      }
      const { id = "", action } = match.groups ?? {};
      return await handleTaskRequest(request, url, id, action);
    },
    async interaction(payload: SlackBlockActionsPayload): Promise<void> {
      const parsed = v.safeParse(interactionSchema, payload);
      if (!parsed.success) {
        return;
      }
      const action = parsed.output.actions.find(
        (entry) =>
          entry.action_id.startsWith("delegation_approve:") ||
          entry.action_id === "delegation_cancel",
      );
      if (action?.value === undefined) {
        return;
      }
      let value: v.InferOutput<typeof decisionValue>;
      try {
        value = v.parse(decisionValue, JSON.parse(action.value));
      } catch {
        return;
      }
      const stored = await store.read(value.id);
      const thread =
        parsed.output.message?.thread_ts ??
        parsed.output.container?.thread_ts ??
        parsed.output.message?.ts;
      if (
        stored === undefined ||
        stored.task.requester !== parsed.output.user.id ||
        stored.task.channel !== parsed.output.channel?.id ||
        stored.task.threadTs !== thread
      ) {
        return;
      }
      if (action.action_id === "delegation_cancel") {
        if (await store.cancel(value.id, parsed.output.user.id)) {
          await cancel(stored);
          await slack(stored.task, "Task cancelled.");
        }
        return;
      }
      const registered = await store.runners();
      const runner = registered.find(
        (entry) =>
          entry.name === value.runner && entry.repos.includes(stored.task.repo),
      );
      if (
        runner === undefined ||
        !(await store.approve(value.id, runner.name, parsed.output.user.id))
      ) {
        return;
      }
      options.waitUntil(
        dispatch({ ...stored.task, state: "approved" }, runner),
      );
    },
    store,
    tool(binding: SlackReadBinding, requester: string, instanceId: string) {
      return defineTool({
        description: proposalDescription,
        input: proposal,
        name: "delegate_to_conductor",
        output: v.object({ id: v.string(), state: v.literal("proposed") }),
        async run({ data, signal }) {
          if (!config.repos.includes(data.repo)) {
            throw new Error("Repo is not configured for delegation");
          }
          let channel = binding.channelId;
          let { threadTs } = binding;
          if (binding.surface === "private") {
            if (
              !binding.readsMemberChannels ||
              (data.channel ?? "") === "" ||
              (data.threadTs ?? "") === ""
            ) {
              throw new Error(
                "Delegation in an owner's DM requires channel and threadTs",
              );
            }
            channel = data.channel ?? "";
            threadTs = data.threadTs ?? "";
          } else if (
            (data.channel !== undefined && data.channel !== channel) ||
            (data.threadTs !== undefined && data.threadTs !== threadTs)
          ) {
            throw new Error("Delegation is bound to the requesting thread");
          }
          const admission = createSqlSlackChannelAdmissionStore(options.db);
          if (!(await admission.isAdmitted(channel))) {
            throw new Error("Channel is not admitted");
          }
          const raw = await readRawSlackThread(
            { fetcher, signal, token: options.botToken },
            channel,
            threadTs,
          );
          const rawThread = raw.map(({ author, permalink, text, ts }) => ({
            author,
            permalink,
            text,
            ts,
          }));
          const reporters = [
            ...new Set(
              raw
                .filter((message) => !message.bot)
                .map((message) => message.author)
                .filter((author) => /^[UW][A-Z0-9]+$/u.test(author)),
            ),
          ];
          const task: DelegationTask = {
            channel,
            expiresAt: Date.now() + 86_400_000,
            id: crypto.randomUUID(),
            rawThread,
            repo: data.repo,
            reporters,
            requester,
            state: "proposed",
            summary: data.summary,
            threadTs,
            title: data.summary.slice(0, 300),
          };
          await store.propose(task, instanceId);
          await options.schedule(instanceId, task);
          const registered = await store.runners();
          const runners = registered.filter((runner) =>
            runner.repos.includes(task.repo),
          );
          const buttons = await Promise.all(
            runners.map(async (runner) => {
              let online = false;
              try {
                const response = await runnerRequest(runner, "/health");
                if (response.ok) {
                  online = v.safeParse(
                    v.object({
                      capacity: v.number(),
                      free: v.number(),
                      name: v.literal(runner.name),
                      ok: v.literal(true),
                      repos: v.array(v.string()),
                    }),
                    await response.json(),
                  ).success;
                }
              } catch {
                online = false;
              }
              return {
                action_id: `delegation_approve:${runner.name}`,
                text: {
                  text: `${runner.name.slice(0, 60)} (${online ? "online" : "offline"})`,
                  type: "plain_text",
                },
                type: "button",
                value: JSON.stringify({ id: task.id, runner: runner.name }),
              };
            }),
          );
          const elements = [
            ...buttons,
            {
              action_id: "delegation_cancel",
              text: { text: "Cancel", type: "plain_text" },
              type: "button",
              value: JSON.stringify({ id: task.id }),
            },
          ];
          const text = `${redact(task.summary)}\nReporters: ${reporters.map((id) => `<@${id}>`).join(" ")}\nOnly <@${requester}> can approve. Expires in 24 hours.`;
          const blocks: unknown[] = [
            {
              text: {
                text: `Only <@${requester}> can approve. Expires in 24 hours.`,
                type: "mrkdwn",
              },
              type: "section",
            },
          ];
          const summary = redact(task.summary).trim() || "Delegation request.";
          for (let index = 0; index < summary.length; index += 3000) {
            blocks.push({
              text: {
                text: summary.slice(index, index + 3000),
                type: "mrkdwn",
              },
              type: "section",
            });
          }
          for (let index = 0; index < reporters.length; index += 100) {
            blocks.push({
              text: {
                text: `Reporters: ${reporters
                  .slice(index, index + 100)
                  .map((id) => `<@${id}>`)
                  .join(" ")}`,
                type: "mrkdwn",
              },
              type: "section",
            });
          }
          for (let index = 0; index < elements.length; index += 25) {
            blocks.push({
              elements: elements.slice(index, index + 25),
              type: "actions",
            });
          }
          await slack(task, text, blocks);
          return { output: { id: task.id, state: "proposed" as const } };
        },
      });
    },
  };
};
export type Delegation = ReturnType<typeof createDelegation>;
