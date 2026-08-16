import { describe, expect, test } from "bun:test";
import {
  composeInstructions,
  composeTools,
  defineAgentConfig,
} from "@agentic-slack/core";
import { defineTool } from "@flue/runtime/tool";
import type { FlueLogger } from "@flue/runtime";

import { createPostHogPlugin } from "../src/index.ts";
import type { PostHogFetcher } from "../src/index.ts";

const noopLogger: FlueLogger = {
  error() {},
  info() {},
  warn() {},
};

const secret = "phx_private_key";
const now = () => Date.parse("2026-08-13T12:00:00.000Z");
const query =
  "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 20";

const terminalTool = () =>
  defineTool({
    description: "Deliver the final reply.",
    name: "reply_in_slack",
    run() {
      return Promise.resolve({ output: "posted", terminate: true });
    },
  });

const plugin = (fetcher: PostHogFetcher, resolverCalls: string[] = []) =>
  createPostHogPlugin<{
    credentials: { host: string; projectId: string; personalApiKey: string };
  }>({
    fetcher,
    now,
    resolve(context) {
      resolverCalls.push("resolved");
      return context.credentials;
    },
  });

const config = (fetcher: PostHogFetcher, resolverCalls: string[] = []) =>
  defineAgentConfig({
    description: "Answers conversations.",
    name: "Neutral Agent",
    ownerInstructions: "Be concise.",
    plugins: [plugin(fetcher, resolverCalls)],
  });

const runtime = () => ({
  credentials: {
    host: "https://eu.posthog.com",
    personalApiKey: secret,
    projectId: "123",
  },
});

const tool = (fetcher: PostHogFetcher) =>
  composeTools(config(fetcher), runtime(), terminalTool())[0];

interface QueryInput {
  readonly presentation: unknown;
  readonly query: string;
  readonly timeRange: unknown;
}

const run = async (fetcher: PostHogFetcher, data: QueryInput) =>
  await tool(fetcher).run({
    data,
    log: noopLogger,
    toolCallId: "test-call",
  });

const metric = { title: "Events", type: "metric", valueColumn: "total" };

const okFetcher: PostHogFetcher = () =>
  Promise.resolve(Response.json({ columns: ["total"], results: [[1]] }));
const failureFetcher: PostHogFetcher = () =>
  Promise.resolve(new Response("private failure", { status: 500 }));
const redirectFetcher: PostHogFetcher = () =>
  Promise.resolve(
    new Response(null, {
      headers: { location: "https://elsewhere.example" },
      status: 302,
    }),
  );
const textFetcher: PostHogFetcher = () =>
  Promise.resolve(
    new Response("not json", { headers: { "content-type": "text/plain" } }),
  );
const oversizedFetcher: PostHogFetcher = () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('{"columns":["total"],"results":[[1]]}'),
      );
      controller.enqueue(new Uint8Array(16_384).fill(32));
      controller.close();
    },
  });
  return Promise.resolve(
    new Response(body, {
      headers: { "content-type": "application/json" },
    }),
  );
};
const nonFiniteFetcher: PostHogFetcher = () =>
  Promise.resolve(
    new Response('{"columns":["total"],"results":[[1e999]]}', {
      headers: { "content-type": "application/json" },
    }),
  );

describe("PostHog read-only plugin", () => {
  test("is runtime-lazy, keeps credentials closure-bound, and remains before core reply", () => {
    const calls: string[] = [];
    const resolved = config(okFetcher, calls);

    expect(calls).toEqual([]);
    expect(JSON.stringify(resolved)).not.toContain(secret);
    expect(composeInstructions(resolved).join(" ")).toContain(
      "operator must grant",
    );
    expect(composeInstructions(resolved).join(" ")).toContain(
      "Query Read access",
    );
    expect(composeInstructions(resolved).join(" ")).toContain(
      "cannot inspect its permissions",
    );
    const tools = composeTools(resolved, runtime(), terminalTool());
    expect(calls).toEqual(["resolved"]);
    expect(tools.map(({ name }) => name)).toEqual([
      "query_posthog",
      "reply_in_slack",
    ]);
    expect(
      JSON.stringify(
        tools.map(({ name, description, input }) => ({
          description,
          input,
          name,
        })),
      ),
    ).not.toContain(secret);
  });

  test("uses the exact HogQL wire contract with server-owned time values", async () => {
    const requests: Request[] = [];
    const fetcher: PostHogFetcher = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({ columns: ["total"], results: [[7]] }),
      );
    };

    expect(
      await run(fetcher, {
        presentation: metric,
        query,
        timeRange: { days: 7, kind: "relative" },
      }),
    ).toEqual({
      output: {
        columns: ["total"],
        dataTrust: "untrusted_analytics_data",
        presentation: metric,
        rows: [[7]],
        status: "ok",
      },
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe("https://eu.posthog.com/api/projects/123/query/");
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(request.headers.get("content-type")).toContain("application/json");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({
      name: "agentic-slack-readonly-analytics",
      query: {
        kind: "HogQLQuery",
        query,
        values: {
          end: "2026-08-13T12:00:00.000Z",
          start: "2026-08-06T12:00:00.000Z",
        },
      },
    });
  });

  test("returns safe unavailable data without exposing failures", async () => {
    expect(
      await run(failureFetcher, {
        presentation: metric,
        query,
        timeRange: { days: 1, kind: "relative" },
      }),
    ).toEqual({ output: { status: "unavailable" } });
  });

  test("rejects redirects, non-JSON, and oversized streamed bodies before parsing", async () => {
    const data = {
      presentation: metric,
      query,
      timeRange: { days: 1, kind: "relative" },
    };
    expect(await run(redirectFetcher, data)).toEqual({
      output: { status: "unavailable" },
    });
    expect(await run(textFetcher, data)).toEqual({
      output: { status: "unavailable" },
    });
    expect(await run(oversizedFetcher, data)).toEqual({
      output: { status: "unavailable" },
    });
  });

  test("rejects unsafe query shapes before network access", async () => {
    let networkCalls = 0;
    const fetcher: PostHogFetcher = () => {
      networkCalls += 1;
      return Promise.resolve(
        Response.json({ columns: ["total"], results: [[1]] }),
      );
    };
    const rejected = [
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end}; LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} OR timestamp <= {end} LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} UNION SELECT count() AS total FROM events LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND event IN (SELECT event FROM events) LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM persons WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT properties.email AS email FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT distinct_id AS identifier FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 21",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1 -- comment",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND INSERT events VALUES ('x') LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND UPDATE events SET event = 'x' LIMIT 1",
      },
      {
        presentation: metric,
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND DELETE events WHERE event = 'x' LIMIT 1",
      },
      {
        presentation: {
          columns: ["total", "raw_timestamp"],
          title: "Events",
          type: "table" as const,
        },
        query:
          "SELECT count() AS total, timestamp AS raw_timestamp FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
      },
    ];
    await Promise.all(
      rejected.map(async (rejectedQuery) => {
        networkCalls = 0;
        expect(
          await run(fetcher, {
            presentation: rejectedQuery.presentation,
            query: rejectedQuery.query,
            timeRange: { days: 1, kind: "relative" },
          }),
        ).toEqual({ output: { status: "unavailable" } });
        expect(networkCalls).toBe(0);
      }),
    );
  });

  test("enforces aliases, presentations, time bounds, and response bounds", async () => {
    let calls = 0;
    const fetcher: PostHogFetcher = () => {
      calls += 1;
      return Promise.resolve(
        Response.json({
          columns: ["total"],
          results: [["x".repeat(201)]],
        }),
      );
    };
    expect(
      await run(fetcher, {
        presentation: metric,
        query:
          "SELECT count() FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
        timeRange: { days: 1, kind: "relative" },
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(
      await run(fetcher, {
        presentation: { title: "Wrong", type: "metric", valueColumn: "other" },
        query,
        timeRange: { days: 1, kind: "relative" },
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(
      await run(fetcher, {
        presentation: metric,
        query,
        timeRange: {
          end: "2026-08-01T00:00:00.000Z",
          kind: "absolute",
          start: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(
      await run(fetcher, {
        presentation: metric,
        query,
        timeRange: { days: 1, kind: "relative" },
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(calls).toBe(1);
  });

  test("rejects host paths and non-finite cells", async () => {
    const pathPlugin = createPostHogPlugin<{
      credentials: { host: string; projectId: string; personalApiKey: string };
    }>({
      fetcher: () =>
        Promise.resolve(Response.json({ columns: ["total"], results: [[1]] })),
      resolve: (context) => context.credentials,
    });
    const pathConfig = defineAgentConfig({
      description: "Answers.",
      name: "Agent",
      ownerInstructions: "Be concise.",
      plugins: [pathPlugin],
    });
    expect(() =>
      composeTools(
        pathConfig,
        {
          credentials: {
            ...runtime().credentials,
            host: "https://eu.posthog.com/api",
          },
        },
        terminalTool(),
      ),
    ).toThrow("Invalid PostHog host");
    expect(
      await run(nonFiniteFetcher, {
        presentation: metric,
        query,
        timeRange: { days: 1, kind: "relative" },
      }),
    ).toEqual({ output: { status: "unavailable" } });
  });
});
