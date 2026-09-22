import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import {
  claimAndRun,
  claimEvent,
  releaseEvent,
} from "../../../packages/core/src/dedup.ts";
import * as v from "valibot";

const bindings = v.array(
  v.union([v.string(), v.number(), v.bigint(), v.boolean(), v.null()]),
);

const migrationsDir = new URL("../migrations/", import.meta.url);
const migrationEntries = await readdir(migrationsDir);
// wrangler d1 migrations apply runs files lexicographically; match that order.
const migrationFiles = migrationEntries
  .filter((name) => name.endsWith(".sql"))
  .toSorted();
const migrationSources = await Promise.all(
  migrationFiles.map((name) => Bun.file(new URL(name, migrationsDir)).text()),
);
const schema = migrationSources.join("\n");

// Pinned independently of dedup.ts so mutating the retention constant goes red.
const retentionSeconds = 7 * 24 * 60 * 60;

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
        all() {
          return Promise.resolve({ results: statement.all(...params) });
        },
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

  test("sweeps only rows older than the retention window", async () => {
    const db = migrated();
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
      )
      .bind("Ev-expired", retentionSeconds + 60)
      .run();
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
      )
      .bind("Ev-recent", 60)
      .run();

    expect(await claimEvent(db, "Ev-claimed")).toBe(true);

    const { results } = await db
      .prepare("SELECT event_id FROM seen_events ORDER BY event_id")
      .all();
    expect(results).toEqual([
      { event_id: "Ev-claimed" },
      { event_id: "Ev-recent" },
    ]);
  });

  test("runs the claimed handler when the retention sweep fails", async () => {
    const db = migrated();
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
      )
      .bind("Ev-expired", retentionSeconds + 60)
      .run();
    await db
      .prepare(
        "CREATE TRIGGER reject_sweep BEFORE DELETE ON seen_events BEGIN SELECT RAISE(ABORT, 'sweep failed'); END",
      )
      .run();

    let runs = 0;
    await claimAndRun(db, "Ev-sweep", () => {
      runs += 1;
      return Promise.resolve();
    });

    expect(runs).toBe(1);
    expect(await claimEvent(db, "Ev-sweep")).toBe(false);
    const { results } = await db
      .prepare("SELECT event_id FROM seen_events ORDER BY event_id")
      .all();
    expect(results).toEqual([
      { event_id: "Ev-expired" },
      { event_id: "Ev-sweep" },
    ]);
  });
});
