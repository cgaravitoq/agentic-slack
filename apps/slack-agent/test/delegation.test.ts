import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import * as v from "valibot";
import {
  createDelegation,
  createSlackProgressEndpoint,
  MODEL_PROVIDER_CLOUDFLARE,
} from "@agentic-slack/core";
import type { SlackBlockActionsPayload } from "@agentic-slack/core";
import type { DelegationOptions } from "../../../packages/core/src/delegation.ts";
import { createApp } from "../src/app.ts";
import { createDelegationStore } from "../../../packages/core/src/delegation-store.ts";

const parameters = v.array(v.union([v.string(), v.number(), v.null()]));
const isDatabase = (candidate: { prepare: unknown }): candidate is D1Database =>
  typeof candidate.prepare === "function";

const database = async (): Promise<D1Database> => {
  const sqlite = new Database(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  const files = await readdir(directory);
  const sources = await Promise.all(
    files
      .filter((name) => name.endsWith(".sql"))
      .toSorted()
      .map((file) => Bun.file(new URL(file, directory)).text()),
  );
  for (const source of sources) {
    sqlite.run(source);
  }
  const db = {
    async batch(
      statements: { run: () => Promise<{ meta: { changes: number } }> }[],
    ) {
      sqlite.run("BEGIN");
      try {
        const results = await Promise.all(
          statements.map((statement) => statement.run()),
        );
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      const statement = sqlite.query(sql);
      let values: v.InferOutput<typeof parameters> = [];
      return {
        all() {
          return Promise.resolve({ results: statement.all(...values) });
        },
        bind(...input: unknown[]) {
          values = v.parse(parameters, input);
          return this;
        },
        run() {
          return Promise.resolve({
            meta: { changes: statement.run(...values).changes },
          });
        },
      };
    },
  };
  if (!isDatabase(db)) {
    throw new Error("Invalid test database");
  }
  return db;
};

const proposal = {
  channel: "C1",
  expiresAt: Date.now() + 86_400_000,
  id: "task-1",
  rawThread: [
    {
      author: "U2",
      permalink: "https://slack.example/1",
      text: "Login fails",
      ts: "171.1",
    },
  ],
  repo: "example",
  reporters: ["U2"],
  requester: "U1",
  state: "proposed" as const,
  summary: "Fix login",
  threadTs: "171.1",
  title: "Fix login",
};

test("migration persists runner registration and a task claim is exclusive and recoverable", async () => {
  const store = createDelegationStore(await database());
  await store.register({
    capacity: 2,
    name: "runner-1",
    repos: ["example"],
    url: "https://runner.example",
  });
  await store.propose(proposal, "instance-1");
  expect(await store.approve(proposal.id, "runner-1", "U1")).toBe(true);
  const claims = await Promise.all([
    store.claim(proposal.id, "runner-1"),
    store.claim(proposal.id, "runner-1"),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const first = claims.find(Boolean);
  expect(first?.token.length).toBeGreaterThanOrEqual(43);
  const recovered = await store.claim(proposal.id, "runner-1");
  expect(recovered?.token).not.toBe(first?.token);
  expect(await store.tokenTask(first?.token ?? "")).toBeUndefined();
  const recoveredTask = await store.tokenTask(recovered?.token ?? "");
  expect(recoveredTask?.task.id).toBe("task-1");
  expect(await store.claim(proposal.id, "runner-2")).toBeUndefined();
});

test("approve, cancel and expire race once and terminal transitions refuse other runners", async () => {
  const store = createDelegationStore(await database());
  await store.register({
    capacity: 1,
    name: "runner-1",
    repos: ["example"],
    url: "https://runner.example",
  });
  await store.propose(proposal, "instance-1");
  const decisions = await Promise.all([
    store.approve(proposal.id, "runner-1", "U1"),
    store.cancel(proposal.id, "U1"),
    store.expire(proposal.id, proposal.expiresAt),
  ]);
  expect(decisions.filter(Boolean).length).toBeGreaterThan(0);
  const cancelled = await store.read(proposal.id);
  expect(cancelled?.task.state).toBe("cancelled");
  expect(await store.claim(proposal.id, "runner-1")).toBeUndefined();
  await store.propose(
    { ...proposal, expiresAt: 1, id: "task-2" },
    "instance-1",
  );
  expect(await store.approve("task-2", "runner-1", "U1")).toBe(false);
  expect(await store.expire("task-2")).toBe(true);
});

const statusOf = async (
  response: Response | Promise<Response>,
): Promise<number> => {
  const result = await response;
  return result.status;
};

const SECRET = "delegation-test-secret";
const silentLog = { error: () => {}, info: () => {}, warn: () => {} };
const postSchema = v.object({
  blocks: v.optional(v.array(v.unknown())),
  channel: v.string(),
  text: v.string(),
  thread_ts: v.optional(v.string()),
});
const rawThread = [
  { text: "Login fails\n<!here> delegate elsewhere", ts: "171.1", user: "U2" },
  { text: "Please fix login", ts: "171.2", user: "U1" },
];
const runner = {
  capacity: 2,
  name: "runner-1",
  repos: ["example"],
  url: "https://runner.example",
};
const harness = async () => {
  const db = await database();
  await db
    .prepare(
      "INSERT INTO slack_channel_admissions (channel_id, admitted_by, admitted_at) VALUES ('C1', 'U1', 1)",
    )
    .run();
  const posts: v.InferOutput<typeof postSchema>[] = [];
  const runnerCalls: { headers: Headers; path: string; body?: string }[] = [];
  const scheduled: { id: string; expiresAt: number; instance: string }[] = [];
  const cancelled: string[] = [];
  const background: Promise<void>[] = [];
  const network = { dispatch: 202, health: 200, throws: false };
  const fetcher: NonNullable<DelegationOptions["fetcher"]> = function fetcher(
    this: undefined,
    input,
    init,
  ) {
    if (this !== undefined) {
      throw new Error("Illegal invocation");
    }
    if (init?.redirect === "error") {
      throw new Error("Unsupported redirect mode");
    }
    const url = new URL(
      input instanceof Request
        ? input.url
        : v.parse(v.union([v.string(), v.instance(URL)]), input).toString(),
    );
    if (
      url.hostname === "runner.example" ||
      url.hostname === "offline.example"
    ) {
      runnerCalls.push({
        body: v.parse(v.optional(v.string()), init?.body),
        headers: new Headers(
          v.parse(v.record(v.string(), v.string()), init?.headers),
        ),
        path: url.pathname,
      });
      if (network.throws) {
        return Promise.reject(new Error("Runner unreachable"));
      }
      const activeStatus =
        url.pathname === "/health" ? network.health : network.dispatch;
      const status = url.hostname === "offline.example" ? 403 : activeStatus;
      if (status === 403) {
        return Promise.resolve(
          new Response("<html>Access denied</html>", { status }),
        );
      }
      return Promise.resolve(
        Response.json(
          {
            capacity: 2,
            free: 1,
            name: "runner-1",
            ok: true,
            repos: ["example"],
          },
          { status },
        ),
      );
    }
    const method = url.pathname.split("/").at(-1);
    if (method === "conversations.replies") {
      return Promise.resolve(Response.json({ messages: rawThread, ok: true }));
    }
    if (method === "auth.test") {
      return Promise.resolve(
        Response.json({ ok: true, url: "https://slack.example/" }),
      );
    }
    if (method === "chat.postMessage") {
      posts.push(
        v.parse(postSchema, JSON.parse(v.parse(v.string(), init?.body))),
      );
      return Promise.resolve(Response.json({ ok: true, ts: "172.1" }));
    }
    if (method === "conversations.info") {
      return Promise.resolve(
        Response.json({ channel: { name: "bugs" }, ok: true }),
      );
    }
    if (method === "users.info") {
      return Promise.resolve(
        Response.json({ ok: true, user: { name: "Reporter" } }),
      );
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const delegation = createDelegation(
    { authSecret: "DELEGATION_SECRET", repos: ["example"] },
    {
      bearer: SECRET,
      botToken: "test-bot-token",
      cancelSchedule: (instance, id) => {
        cancelled.push(`${instance}:${id}`);
        return Promise.resolve();
      },
      db,
      fetcher,
      runnerHeaders: {
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      },
      schedule: (instance, task) => {
        scheduled.push({ expiresAt: task.expiresAt, id: task.id, instance });
        return Promise.resolve();
      },
      waitUntil: (work) => {
        background.push(work);
      },
    },
  );
  const request = (
    path: string,
    method: "GET" | "POST" = "GET",
    body?: string,
    bearer = SECRET,
  ) => {
    const init: RequestInit = {
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      method,
    };
    if (method === "POST") {
      init.body = body;
    }
    return delegation.handle(
      new Request(`https://helper.example${path}`, init),
    );
  };
  const tool = delegation.tool(
    {
      channelId: "C1",
      readsMemberChannels: false,
      surface: "channel",
      threadTs: "171.1",
    },
    "U1",
    "instance-1",
  );
  const propose = (summary = "Fix login") =>
    tool.run({
      data: v.parse(tool.input, { repo: "example", summary }),
      log: silentLog,
      toolCallId: "delegate-1",
    });
  return {
    background,
    cancelled,
    db,
    delegation,
    fetcher,
    network,
    posts,
    propose,
    request,
    runnerCalls,
    scheduled,
    tool,
  };
};
const click = (
  id: string,
  user = "U1",
  action = "delegation_approve:runner-1",
): SlackBlockActionsPayload => ({
  actions: [
    {
      action_id: action,
      block_id: "delegation",
      type: "button",
      value: JSON.stringify({ id, runner: "runner-1" }),
    },
  ],
  api_app_id: "A1",
  channel: { id: "C1" },
  container: { thread_ts: "171.1", type: "message" },
  message: { thread_ts: "171.1", ts: "172.1" },
  team: { id: "T1" },
  type: "block_actions",
  user: { id: user },
});

test("tool captures raw thread in code, lists online and offline runners and schedules 24 hour expiry", async () => {
  const h = await harness();
  expect(
    await statusOf(
      h.request("/delegation/runners", "POST", JSON.stringify(runner)),
    ),
  ).toBe(200);
  await h.request(
    "/delegation/runners",
    "POST",
    JSON.stringify({
      ...runner,
      name: "offline",
      url: "https://offline.example",
    }),
  );
  const before = Date.now();
  const { output } = await h.propose("Fix login <!here>");
  const stored = await h.delegation.store.read(output.id);
  expect(stored?.task.rawThread).toEqual([
    {
      author: "U2",
      permalink: "https://slack.example/archives/C1/p1711",
      text: rawThread[0]?.text,
      ts: "171.1",
    },
    {
      author: "U1",
      permalink:
        "https://slack.example/archives/C1/p1712?thread_ts=171.1&cid=C1",
      text: "Please fix login",
      ts: "171.2",
    },
  ]);
  expect(stored?.task.reporters).toEqual(["U2", "U1"]);
  expect(h.scheduled[0]?.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000);
  expect(h.scheduled[0]?.instance).toBe("instance-1");
  const card = JSON.stringify(h.posts[0]);
  expect(card).toContain("runner-1 (online)");
  expect(card).toContain("offline (offline)");
  expect(card).toContain("Cancel");
  const blocks = v.parse(
    v.array(
      v.looseObject({
        elements: v.optional(v.array(v.object({ action_id: v.string() }))),
      }),
    ),
    h.posts[0]?.blocks,
  );
  const actionIds = blocks
    .flatMap((block) => block.elements ?? [])
    .map((element) => element.action_id);
  expect(new Set(actionIds).size).toBe(3);
  expect(card).toContain("<@U2>");
  expect(card).not.toContain("<!here>");
  expect(h.runnerCalls[0]?.headers.get("CF-Access-Client-Id")).toBe(
    "client-id",
  );
  expect(h.runnerCalls[0]?.headers.get("CF-Access-Client-Secret")).toBe(
    "client-secret",
  );
});

test("tool refuses an unconfigured repo and DM targets outside admitted channels", async () => {
  const h = await harness();
  expect(
    h.tool.run({
      data: { repo: "other", summary: "Fix" },
      log: silentLog,
      toolCallId: "bad-repo",
    }),
  ).rejects.toThrow("Repo is not configured");
  const dm = h.delegation.tool(
    {
      channelId: "D1",
      readsMemberChannels: true,
      surface: "private",
      threadTs: "171.1",
    },
    "U1",
    "instance-1",
  );
  expect(
    dm.run({
      data: { repo: "example", summary: "Fix" },
      log: silentLog,
      toolCallId: "dm",
    }),
  ).rejects.toThrow("requires channel");
  expect(
    dm.run({
      data: {
        channel: "C2",
        repo: "example",
        summary: "Fix",
        threadTs: "171.1",
      },
      log: silentLog,
      toolCallId: "dm",
    }),
  ).rejects.toThrow("not admitted");
  expect(
    h.tool.run({
      data: { channel: "C2", repo: "example", summary: "Fix" },
      log: silentLog,
      toolCallId: "channel",
    }),
  ).rejects.toThrow("bound");
  const result = await dm.run({
    data: { channel: "C1", repo: "example", summary: "Fix", threadTs: "171.1" },
    log: silentLog,
    toolCallId: "dm",
  });
  expect(result.output.state).toBe("proposed");
});

test("requester-only approval dispatches in waitUntil and started waits for the runner state", async () => {
  const h = await harness();
  await h.request("/delegation/runners", "POST", JSON.stringify(runner));
  const { output } = await h.propose();
  await h.delegation.interaction(click(output.id, "U2"));
  expect(h.background).toHaveLength(0);
  await h.delegation.interaction(click(output.id));
  expect(h.background).toHaveLength(1);
  await Promise.all(h.background);
  const listed = await h.request("/delegation/tasks?runner=runner-1");
  const list = v.parse(
    v.object({
      tasks: v.array(v.object({ id: v.string(), state: v.string() })),
    }),
    await listed.json(),
  );
  expect(list.tasks).toEqual([{ id: output.id, state: "approved" }]);
  expect(h.posts).toHaveLength(1);
  const dispatch = h.runnerCalls.find((call) => call.path === "/tasks");
  expect(dispatch?.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  expect(JSON.parse(dispatch?.body ?? "null")).toMatchObject({
    task: {
      id: output.id,
      rawThread: [{ author: "U2" }, { author: "U1" }],
      state: "approved",
    },
  });
  const claim = await h.request(
    `/delegation/tasks/${output.id}/claim`,
    "POST",
    JSON.stringify({ runner: "runner-1" }),
  );
  expect(claim.status).toBe(200);
  expect(h.cancelled).toEqual([`instance-1:${output.id}`]);
  const started = await h.request(
    `/delegation/tasks/${output.id}/state`,
    "POST",
    JSON.stringify({ runner: "runner-1", state: "running" }),
  );
  expect(started.status).toBe(200);
  expect(h.posts.at(-1)?.text).toBe("Started.");
});

test.each([409, 403, 500])(
  "refused send %s and Access HTML keep tasks queued",
  async (status) => {
    const h = await harness();
    await h.request("/delegation/runners", "POST", JSON.stringify(runner));
    h.network.health = 403;
    h.network.dispatch = status;
    const { output } = await h.propose();
    expect(JSON.stringify(h.posts[0])).toContain("offline");
    await h.delegation.interaction(click(output.id));
    await Promise.all(h.background);
    expect(h.posts.at(-1)?.text).toBe("Queued until the runner is back.");
    const queued = await h.delegation.store.read(output.id);
    expect(queued?.task.state).toBe("approved");
  },
);

test("cancel and expiry prevent claims, but claimed tasks survive the proposal deadline", async () => {
  const h = await harness();
  await h.request("/delegation/runners", "POST", JSON.stringify(runner));
  const { output } = await h.propose();
  await h.delegation.interaction(click(output.id, "U2", "delegation_cancel"));
  expect(h.cancelled).toHaveLength(0);
  await h.delegation.interaction(click(output.id, "U1", "delegation_cancel"));
  expect(h.cancelled).toEqual([`instance-1:${output.id}`]);
  await h.delegation.interaction(click(output.id));
  expect(h.background).toHaveLength(0);
  await h.delegation.store.propose({ ...proposal, expiresAt: 1 }, "instance-1");
  await h.delegation.expire(proposal.id);
  expect(h.posts.at(-1)?.text).toContain("expired");
  expect(
    await statusOf(
      h.request(
        `/delegation/tasks/${proposal.id}/claim`,
        "POST",
        JSON.stringify({ runner: "runner-1" }),
      ),
    ),
  ).toBe(409);
  await h.delegation.store.propose(
    { ...proposal, id: "claimed-task" },
    "instance-1",
  );
  await h.delegation.store.approve("claimed-task", "runner-1", "U1");
  await h.delegation.store.claim("claimed-task", "runner-1");
  expect(
    await h.delegation.store.expire("claimed-task", proposal.expiresAt + 1),
  ).toBe(false);
});

test("task token scopes progress and replies, and verbatim done settles its receipt atomically", async () => {
  const h = await harness();
  await h.request("/delegation/runners", "POST", JSON.stringify(runner));
  const { output } = await h.propose();
  await h.delegation.interaction(click(output.id));
  await Promise.all(h.background);
  const response = await h.request(
    `/delegation/tasks/${output.id}/claim`,
    "POST",
    JSON.stringify({ runner: "runner-1" }),
  );
  const claim = v.parse(v.object({ token: v.string() }), await response.json());
  const progress = createSlackProgressEndpoint(
    {
      authSecret: "PROGRESS_SECRET",
      labels: {
        blocked: "Blocked",
        done: "Done",
        merged: "Merged",
        pr: "PR",
        progress: "Progress",
        review: "Review",
        started: "Started",
      },
    },
    {
      bearer: "progress-secret",
      db: h.db,
      delegation: h.delegation,
      fetcher: h.fetcher,
      narrate: async () => {},
      teamId: "T1",
      token: "bot-token",
    },
  );
  const milestone = {
    channel: "C1",
    id: "m-1",
    kind: "progress",
    task: `delegation:${output.id}`,
    text: "Working",
    threadTs: "171.1",
    title: "Fix login",
    verbatim: true,
  };
  const post = (body: typeof milestone) =>
    progress.handle(
      new Request("https://helper.example/progress", {
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${claim.token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
  await Promise.all(
    [
      { ...milestone, channel: "C2" },
      { ...milestone, task: "another-task" },
      { ...milestone, threadTs: "171.2" },
    ].map(async (body) => {
      const refusal = await post(body);
      expect(refusal.status).toBe(403);
      expect(await refusal.json()).toEqual({ error: "token_scope", ok: false });
    }),
  );
  expect(await statusOf(post(milestone))).toBe(200);
  const replies = (query: string) =>
    progress.handleReplies(
      new Request(`https://helper.example/progress/replies?${query}`, {
        headers: { authorization: `Bearer ${claim.token}` },
      }),
    );
  expect(
    await statusOf(replies(`channel=C1&task=delegation:${output.id}`)),
  ).toBe(200);
  expect(
    await statusOf(replies(`channel=C2&task=delegation:${output.id}`)),
  ).toBe(403);
  expect(
    await statusOf(
      progress.handleChannels(
        new Request("https://helper.example/progress/channels", {
          headers: { authorization: `Bearer ${claim.token}` },
        }),
      ),
    ),
  ).toBe(403);
  const strangers: HeadersInit[] = [
    {},
    { authorization: "Bearer not-a-task-token" },
  ];
  const refusals = await Promise.all(
    strangers.flatMap((headers) => [
      progress.handle(
        new Request("https://helper.example/progress", {
          body: JSON.stringify(milestone),
          headers,
          method: "POST",
        }),
      ),
      progress.handleReplies(
        new Request(
          `https://helper.example/progress/replies?channel=C1&task=delegation:${output.id}`,
          { headers },
        ),
      ),
      progress.handleChannels(
        new Request("https://helper.example/progress/channels", { headers }),
      ),
    ]),
  );
  expect(
    await Promise.all(
      refusals.map(async (refused) => [refused.status, await refused.json()]),
    ),
  ).toEqual(refusals.map(() => [401, { error: "unauthorized", ok: false }]));
  expect(
    await statusOf(
      h.request(
        "/delegation/tasks?runner=runner-1",
        "GET",
        undefined,
        claim.token,
      ),
    ),
  ).toBe(403);
  expect(
    await statusOf(
      post({
        ...milestone,
        id: "ordinary-done",
        kind: "done",
        verbatim: false,
      }),
    ),
  ).toBe(200);
  const unfinished = await h.delegation.store.read(output.id);
  expect(unfinished?.task.state).toBe("claimed");
  expect(
    await statusOf(post({ ...milestone, id: "done-1", kind: "done" })),
  ).toBe(200);
  const done = await h.delegation.store.read(output.id);
  expect(done?.task.state).toBe("done");
  const receipt = await h.db
    .prepare(
      "SELECT state, ts FROM progress_receipts WHERE milestone_id = 'done-1'",
    )
    .all();
  expect(receipt.results).toEqual([{ state: "posted", ts: "172.1" }]);
  expect(await statusOf(post({ ...milestone, id: "after-done" }))).toBe(401);
  expect(
    await statusOf(replies(`channel=C1&task=delegation:${output.id}`)),
  ).toBe(401);
});

test("delegation HTTP routes are absent without configuration and mount when configured", async () => {
  const h = await harness();
  const trusted = {
    appId: "A1",
    botToken: "bot-token",
    signingSecret: "signing-secret",
    teamId: "T1",
  };
  const absent = createApp(trusted, MODEL_PROVIDER_CLOUDFLARE, async () => {});
  expect(
    await statusOf(absent.request("/delegation/tasks?runner=runner-1")),
  ).toBe(404);
  expect(
    await statusOf(
      absent.request("/channels/slack/interactions", { method: "POST" }),
    ),
  ).toBe(404);
  const app = createApp(
    trusted,
    MODEL_PROVIDER_CLOUDFLARE,
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    h.delegation,
  );
  expect(
    await statusOf(
      app.request("/delegation/runners", {
        body: JSON.stringify(runner),
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    ),
  ).toBe(200);
  expect(await statusOf(app.request("/delegation/tasks?runner=runner-1"))).toBe(
    401,
  );
});

test("default global fetch obeys the workerd receiver and redirect constraints", async () => {
  const h = await harness();
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(h.fetcher, { preconnect: fetch.preconnect }),
  );
  try {
    const delegation = createDelegation(
      { authSecret: "SECRET", repos: ["example"] },
      {
        bearer: SECRET,
        botToken: "bot",
        cancelSchedule: async () => {},
        db: h.db,
        runnerHeaders: {},
        schedule: async () => {},
        waitUntil: (work) => {
          h.background.push(work);
        },
      },
    );
    await delegation.store.register(runner);
    const tool = delegation.tool(
      {
        channelId: "C1",
        readsMemberChannels: false,
        surface: "channel",
        threadTs: "171.1",
      },
      "U1",
      "instance-1",
    );
    const result = await tool.run({
      data: { repo: "example", summary: "Fix login" },
      log: silentLog,
      toolCallId: "global-fetch",
    });
    expect(JSON.stringify(h.posts[0])).toContain("online");
    await delegation.interaction(click(result.output.id));
    await Promise.all(h.background);
    expect(h.runnerCalls.map((call) => call.path)).toEqual([
      "/health",
      "/tasks",
    ]);
  } finally {
    spy.mockRestore();
  }
});

test("claim versus cancellation is exclusive and runner state transitions preserve unknown recovery", async () => {
  const h = await harness();
  await h.delegation.store.register(runner);
  await h.delegation.store.propose(proposal, "instance-1");
  await h.delegation.store.approve(proposal.id, runner.name, "U1");
  const [claim, cancelled] = await Promise.all([
    h.delegation.store.claim(proposal.id, runner.name),
    h.delegation.store.cancel(proposal.id, "U1"),
  ]);
  expect(Number(claim !== undefined) + Number(cancelled)).toBe(1);
  await h.delegation.store.propose({ ...proposal, id: "task-2" }, "instance-1");
  await h.delegation.store.approve("task-2", runner.name, "U1");
  const token = await h.delegation.store.claim("task-2", runner.name);
  expect(
    await statusOf(
      h.request(
        "/delegation/tasks/task-2/state",
        "POST",
        JSON.stringify({ runner: "other", state: "running" }),
      ),
    ),
  ).toBe(409);
  expect(
    await statusOf(
      h.request(
        "/delegation/tasks/task-2/state",
        "POST",
        JSON.stringify({
          note: "x".repeat(501),
          runner: runner.name,
          state: "running",
        }),
      ),
    ),
  ).toBe(400);
  expect(
    await statusOf(
      h.request(
        "/delegation/tasks/task-2/state",
        "POST",
        JSON.stringify({ runner: runner.name, state: "unknown" }),
      ),
    ),
  ).toBe(200);
  expect(await h.delegation.store.tokenTask(token?.token ?? "")).toBeDefined();
  expect(
    await statusOf(
      h.request(
        "/delegation/tasks/task-2/state",
        "POST",
        JSON.stringify({ runner: runner.name, state: "running" }),
      ),
    ),
  ).toBe(409);
  expect(
    await statusOf(
      h.request(
        "/delegation/tasks/task-2/state",
        "POST",
        JSON.stringify({ runner: runner.name, state: "failed" }),
      ),
    ),
  ).toBe(200);
  expect(
    await h.delegation.store.tokenTask(token?.token ?? ""),
  ).toBeUndefined();
  expect(
    await statusOf(h.request("/delegation/tasks/task-2?runner=other")),
  ).toBe(404);
  expect(
    await statusOf(h.request("/delegation/tasks/task-2?runner=runner-1")),
  ).toBe(200);
});

test("a transport failure keeps approval queued until the runner returns", async () => {
  const h = await harness();
  await h.delegation.store.register(runner);
  const result = await h.propose();
  h.network.throws = true;
  await h.delegation.interaction(click(result.output.id));
  await Promise.all(h.background);
  expect(h.posts.at(-1)?.text).toBe("Queued until the runner is back.");
  expect(await h.delegation.store.approved(runner.name)).toHaveLength(1);
});

test("approval preserves a long summary while bounding its title and Slack sections", async () => {
  const h = await harness();
  await h.delegation.store.register({ ...runner, name: "r".repeat(100) });
  const summary = "x".repeat(5000);
  const result = await h.propose(summary);
  const stored = await h.delegation.store.read(result.output.id);
  expect(stored?.task.summary).toBe(summary);
  expect(stored?.task.title).toHaveLength(300);
  const sections = v.parse(
    v.array(
      v.looseObject({
        text: v.optional(v.object({ text: v.string(), type: v.string() })),
      }),
    ),
    h.posts[0]?.blocks,
  );
  expect(
    sections
      .filter((block) => block.text?.text.startsWith("x") === true)
      .map((block) => block.text?.text)
      .join(""),
  ).toBe(summary);
  expect(
    sections.every((block) => (block.text?.text.length ?? 0) <= 3000),
  ).toBe(true);
});
