import { describe, expect, test } from "bun:test";
import {
  composeInstructions,
  composeTools,
  defineAgentConfig,
} from "@agentic-slack/core";
import { defineTool } from "@flue/runtime/tool";

import { createPostHogPlugin, type PostHogFetcher } from "../src/index.ts";

const secret = "phx_private_key";
const now = () => Date.parse("2026-08-13T12:00:00.000Z");
const query =
  "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 20";

function terminalTool() {
  return defineTool({
    name: "reply_in_slack",
    description: "Deliver the final reply.",
    async run() {
      return { output: "posted", terminate: true };
    },
  });
}

function plugin(fetcher: PostHogFetcher, resolverCalls: string[] = []) {
  return createPostHogPlugin<{
    credentials: { host: string; projectId: string; personalApiKey: string };
  }>({
    resolve(context) {
      resolverCalls.push("resolved");
      return context.credentials;
    },
    fetcher,
    now,
  });
}

function config(fetcher: PostHogFetcher, resolverCalls: string[] = []) {
  return defineAgentConfig({
    name: "Neutral Agent",
    description: "Answers conversations.",
    ownerInstructions: "Be concise.",
    plugins: [plugin(fetcher, resolverCalls)],
  });
}

function runtime() {
  return {
    credentials: {
      host: "https://eu.posthog.com",
      projectId: "123",
      personalApiKey: secret,
    },
  };
}

function tool(fetcher: PostHogFetcher) {
  return composeTools(config(fetcher), runtime(), terminalTool())[0]!;
}

async function run(fetcher: PostHogFetcher, data: Record<string, unknown>) {
  return tool(fetcher).run({ data } as never);
}

const metric = { type: "metric", title: "Events", valueColumn: "total" };

describe("PostHog read-only plugin", () => {
  test("is runtime-lazy, keeps credentials closure-bound, and remains before core reply", () => {
    const calls: string[] = [];
    const fetcher: PostHogFetcher = async () =>
      Response.json({ columns: ["total"], results: [[1]] });
    const resolved = config(fetcher, calls);

    expect(calls).toEqual([]);
    expect(JSON.stringify(resolved)).not.toContain(secret);
    expect(composeInstructions(resolved).join(" ")).toContain("query:read");
    const tools = composeTools(resolved, runtime(), terminalTool());
    expect(calls).toEqual(["resolved"]);
    expect(tools.map(({ name }) => name)).toEqual([
      "query_posthog",
      "reply_in_slack",
    ]);
    expect(
      JSON.stringify(
        tools.map(({ name, description, input }) => ({
          name,
          description,
          input,
        })),
      ),
    ).not.toContain(secret);
  });

  test("uses the exact HogQL wire contract with server-owned time values", async () => {
    const requests: Request[] = [];
    const fetcher: PostHogFetcher = async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ columns: ["total"], results: [[7]] });
    };

    expect(
      await run(fetcher, {
        query,
        timeRange: { kind: "relative", days: 7 },
        presentation: metric,
      }),
    ).toEqual({
      output: {
        status: "ok",
        dataTrust: "untrusted_analytics_data",
        presentation: metric,
        columns: ["total"],
        rows: [[7]],
      },
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://eu.posthog.com/api/projects/123/query/");
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(request.headers.get("content-type")).toContain("application/json");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({
      query: {
        kind: "HogQLQuery",
        query,
        values: {
          start: "2026-08-06T12:00:00.000Z",
          end: "2026-08-13T12:00:00.000Z",
        },
      },
      name: "agentic-slack-readonly-analytics",
    });
  });

  test("returns safe unavailable data without exposing failures", async () => {
    const fetcher: PostHogFetcher = async () =>
      new Response("private failure", { status: 500 });
    expect(
      await run(fetcher, {
        query,
        timeRange: { kind: "relative", days: 1 },
        presentation: metric,
      }),
    ).toEqual({ output: { status: "unavailable" } });
  });

  test("rejects redirects, non-JSON, and oversized streamed bodies before parsing", async () => {
    const redirect: PostHogFetcher = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example" },
      });
    const text: PostHogFetcher = async () =>
      new Response("not json", { headers: { "content-type": "text/plain" } });
    const oversized: PostHogFetcher = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('{"columns":["total"],"results":[[1]]}'),
          );
          controller.enqueue(new Uint8Array(16_384).fill(32));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "application/json" },
      });
    };
    const data = {
      query,
      timeRange: { kind: "relative", days: 1 },
      presentation: metric,
    };
    expect(await run(redirect, data)).toEqual({
      output: { status: "unavailable" },
    });
    expect(await run(text, data)).toEqual({
      output: { status: "unavailable" },
    });
    expect(await run(oversized, data)).toEqual({
      output: { status: "unavailable" },
    });
  });

  test("rejects unsafe query shapes before network access", async () => {
    let networkCalls = 0;
    const fetcher: PostHogFetcher = async () => {
      networkCalls += 1;
      return Response.json({ columns: ["total"], results: [[1]] });
    };
    const rejected = [
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end}; LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} OR timestamp <= {end} LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} UNION SELECT count() AS total FROM events LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND event IN (SELECT event FROM events) LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM persons WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT properties.email AS email FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT distinct_id AS identifier FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 21",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1 -- comment",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND INSERT events VALUES ('x') LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND UPDATE events SET event = 'x' LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total FROM events WHERE timestamp >= {start} AND timestamp <= {end} AND DELETE events WHERE event = 'x' LIMIT 1",
        presentation: metric,
      },
      {
        query:
          "SELECT count() AS total, timestamp AS raw_timestamp FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
        presentation: {
          type: "table" as const,
          title: "Events",
          columns: ["total", "raw_timestamp"],
        },
      },
    ];
    for (const rejectedQuery of rejected) {
      networkCalls = 0;
      expect(
        await run(fetcher, {
          query: rejectedQuery.query,
          timeRange: { kind: "relative", days: 1 },
          presentation: rejectedQuery.presentation,
        }),
      ).toEqual({ output: { status: "unavailable" } });
      expect(networkCalls).toBe(0);
    }
  });

  test("enforces aliases, presentations, time bounds, and response bounds", async () => {
    let calls = 0;
    const fetcher: PostHogFetcher = async () => {
      calls += 1;
      return Response.json({
        columns: ["total"],
        results: [["x".repeat(201)]],
      });
    };
    expect(
      await run(fetcher, {
        query:
          "SELECT count() FROM events WHERE timestamp >= {start} AND timestamp <= {end} LIMIT 1",
        timeRange: { kind: "relative", days: 1 },
        presentation: metric,
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(
      await run(fetcher, {
        query,
        timeRange: { kind: "relative", days: 1 },
        presentation: { type: "metric", title: "Wrong", valueColumn: "other" },
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(
      await run(fetcher, {
        query,
        timeRange: {
          kind: "absolute",
          start: "2026-01-01T00:00:00.000Z",
          end: "2026-08-01T00:00:00.000Z",
        },
        presentation: metric,
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(
      await run(fetcher, {
        query,
        timeRange: { kind: "relative", days: 1 },
        presentation: metric,
      }),
    ).toEqual({ output: { status: "unavailable" } });
    expect(calls).toBe(1);
  });

  test("rejects host paths and non-finite cells", async () => {
    const pathPlugin = createPostHogPlugin<{
      credentials: { host: string; projectId: string; personalApiKey: string };
    }>({
      resolve: (context) => context.credentials,
      fetcher: async () =>
        Response.json({ columns: ["total"], results: [[1]] }),
    });
    const pathConfig = defineAgentConfig({
      name: "Agent",
      description: "Answers.",
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
    const nonFinite: PostHogFetcher = async () =>
      new Response('{"columns":["total"],"results":[[1e999]]}', {
        headers: { "content-type": "application/json" },
      });
    expect(
      await run(nonFinite, {
        query,
        timeRange: { kind: "relative", days: 1 },
        presentation: metric,
      }),
    ).toEqual({ output: { status: "unavailable" } });
  });
});
