import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { claimAndRun, claimEvent, releaseEvent } from "@agentic-slack/core";
import * as v from "valibot";

const bindings = v.array(
  v.union([v.string(), v.number(), v.bigint(), v.boolean(), v.null()]),
);

const schema = await Bun.file(
  new URL("../migrations/0001_seen_events.sql", import.meta.url),
).text();

interface PrepareDouble {
  readonly prepare?: unknown;
}

const isD1Database = (value: PrepareDouble): value is D1Database => {
  const entry = Object.entries(value).find(([key]) => key === "prepare");
  return typeof entry?.[1] === "function";
};

const migrated = (): D1Database => {
  const sqlite = new Database(":memory:");
  sqlite.run(schema);
  const db = {
    prepare(sql: string) {
      const statement = sqlite.query(sql);
      let params: v.InferOutput<typeof bindings> = [];
      return {
        bind(...values: unknown[]) {
          params = v.parse(bindings, values);
          return this;
        },
        run() {
          const { changes } = statement.run(...params);
          return Promise.resolve({ meta: { changes } });
        },
      };
    },
  };
  if (!isD1Database(db)) {
    throw new Error("Invalid D1 test database");
  }
  return db;
};

describe("D1 migration schema", () => {
  test("supports the exact dedup statements the worker issues", async () => {
    const db = migrated();

    expect(await claimEvent(db, "Ev-first")).toBe(true);
    expect(await claimEvent(db, "Ev-first")).toBe(false);
    expect(await claimEvent(db, "Ev-second")).toBe(true);

    await releaseEvent(db, "Ev-first");
    expect(await claimEvent(db, "Ev-first")).toBe(true);
    expect(await claimEvent(db, "Ev-second")).toBe(false);
  });

  test("keeps a failed event claimable and a succeeded event deduplicated", async () => {
    const db = migrated();
    let failure: unknown;
    try {
      await claimAndRun(db, "Ev-retry", () =>
        Promise.reject(new Error("dispatch failed")),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error("dispatch failed"));

    let completed = 0;
    const succeed = () => {
      completed += 1;
      return Promise.resolve();
    };
    await claimAndRun(db, "Ev-retry", succeed);
    await claimAndRun(db, "Ev-retry", succeed);
    expect(completed).toBe(1);
  });
});
