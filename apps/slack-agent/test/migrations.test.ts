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

// Reproduces wrangler's compareMigrationPaths: it orders by the parsed leading
// number, which only coincides with lexicographic order while every name is
// zero-padded to the same width.
const leadingMigrationNumber = (segment: string): number => {
  const digits = /^\d+/u.exec(segment.split("_")[0]);
  return digits === null ? Number.NaN : Number(digits[0]);
};

const compareSegments = (a: string, b: string): number => {
  const aNumber = leadingMigrationNumber(a);
  const bNumber = leadingMigrationNumber(b);
  if (aNumber !== bNumber) {
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
      return aNumber - bNumber;
    }
    if (Number.isFinite(aNumber)) {
      return -1;
    }
    if (Number.isFinite(bNumber)) {
      return 1;
    }
  }
  return a < b ? -1 : Number(a > b);
};

const compareMigrationPaths = (a: string, b: string): number => {
  const aSegments = a.split("/");
  const bSegments = b.split("/");
  const shared = Math.min(aSegments.length, bSegments.length);
  for (const [index, segment] of aSegments.slice(0, shared).entries()) {
    const comparison = compareSegments(segment, bSegments[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return aSegments.length - bSegments.length;
};

const migrationsDir = new URL("../migrations/", import.meta.url);
const migrationEntries = await readdir(migrationsDir);
const migrationFiles = migrationEntries
  .filter((name) => name.endsWith(".sql"))
  .toSorted(compareMigrationPaths);
const migrationSources = await Promise.all(
  migrationFiles.map((name) => Bun.file(new URL(name, migrationsDir)).text()),
);

// Pinned here rather than imported from dedup.ts so that changing either
// constant reds these tests instead of moving them.
const retentionSeconds = 7 * 24 * 60 * 60;
const sweepBatchLimit = 1000;

const sweepIndex = "idx_seen_events_created_at";

interface PrepareDouble {
  readonly prepare?: unknown;
}

const isD1Database = (value: PrepareDouble): value is D1Database => {
  const entry = Object.entries(value).find(([key]) => key === "prepare");
  return typeof entry?.[1] === "function";
};

interface MigratedDatabase {
  readonly db: D1Database;
  readonly prepared: string[];
}

const migrated = (): MigratedDatabase => {
  const sqlite = new Database(":memory:");
  // wrangler d1 migrations apply runs one file per statement batch, in order.
  for (const source of migrationSources) {
    sqlite.run(source);
  }
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
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
  return { db, prepared };
};

const rejection = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
    return "resolved";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const staleCount = async (db: D1Database): Promise<unknown[]> => {
  const { results } = await db
    .prepare(
      "SELECT count(*) AS stale FROM seen_events WHERE event_id LIKE 'Ev-stale-%'",
    )
    .all();
  return results;
};

describe("D1 migration schema", () => {
  test("applies every migration file in wrangler's order", () => {
    expect(migrationFiles).toEqual([
      "0001_seen_events.sql",
      "0002_seen_events_created_at.sql",
    ]);
    expect(
      ["10_tenth.sql", "9_ninth.sql", "0002_second.sql"].toSorted(
        compareMigrationPaths,
      ),
    ).toEqual(["0002_second.sql", "9_ninth.sql", "10_tenth.sql"]);
  });

  test("indexes created_at and plans the sweep through that index", async () => {
    const { db, prepared } = migrated();

    const { results: indexes } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'seen_events' ORDER BY name",
      )
      .all();
    expect(indexes).toEqual([
      { name: sweepIndex },
      { name: "sqlite_autoindex_seen_events_1" },
    ]);

    const { results: columns } = await db
      .prepare(`PRAGMA index_info('${sweepIndex}')`)
      .all();
    expect(columns).toEqual([{ cid: 1, name: "created_at", seqno: 0 }]);

    expect(await claimEvent(db, "Ev-plan")).toBe(true);
    const sweeps = prepared.filter((sql) => sql.startsWith("DELETE"));
    expect(sweeps).toHaveLength(1);

    const { results: plan } = await db
      .prepare(`EXPLAIN QUERY PLAN ${sweeps[0]}`)
      .bind(retentionSeconds, sweepBatchLimit)
      .all();
    const details = plan.map((step) => step.detail);
    expect(details).toContain(
      `SEARCH seen_events USING COVERING INDEX ${sweepIndex} (created_at<?)`,
    );
    expect(details).not.toContain("SCAN seen_events");
  });

  test("supports the exact dedup statements the worker issues", async () => {
    const { db } = migrated();

    expect(await claimEvent(db, "Ev-first")).toBe(true);
    expect(await claimEvent(db, "Ev-first")).toBe(false);
    expect(await claimEvent(db, "Ev-second")).toBe(true);

    await releaseEvent(db, "Ev-first");
    expect(await claimEvent(db, "Ev-first")).toBe(true);
    expect(await claimEvent(db, "Ev-second")).toBe(false);
  });

  test("keeps a failed event claimable and a succeeded event deduplicated", async () => {
    const { db } = migrated();
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
    const { db } = migrated();
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
      )
      .bind("Ev-expired", retentionSeconds + 1)
      .run();
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
      )
      .bind("Ev-recent", retentionSeconds - 1)
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

  test("sweeps one batch at a time and leaves the remainder behind", async () => {
    const { db } = migrated();
    const stale = sweepBatchLimit + 2;
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) WITH RECURSIVE counter(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < ?2) SELECT 'Ev-stale-' || i, unixepoch() - ?1 FROM counter",
      )
      .bind(retentionSeconds + 1, stale)
      .run();

    expect(await claimEvent(db, "Ev-batch")).toBe(true);
    expect(await staleCount(db)).toEqual([{ stale: stale - sweepBatchLimit }]);

    const { results: survivors } = await db
      .prepare(
        "SELECT event_id FROM seen_events WHERE event_id LIKE 'Ev-stale-%' ORDER BY rowid",
      )
      .all();
    expect(survivors).toHaveLength(stale - sweepBatchLimit);
    expect(await claimEvent(db, String(survivors[0].event_id))).toBe(false);

    expect(await claimEvent(db, "Ev-batch-again")).toBe(true);
    expect(await staleCount(db)).toEqual([{ stale: 0 }]);
  });

  test("runs the claimed handler when the retention sweep fails", async () => {
    const { db } = migrated();
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
      )
      .bind("Ev-expired", retentionSeconds + 1)
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

  test("propagates a failing claim instead of reporting one", async () => {
    const { db } = migrated();
    await db
      .prepare(
        "CREATE TRIGGER reject_claim BEFORE INSERT ON seen_events BEGIN SELECT RAISE(ABORT, 'claim failed'); END",
      )
      .run();

    expect(await rejection(claimEvent(db, "Ev-blocked"))).toBe("claim failed");

    let runs = 0;
    const failure = await rejection(
      claimAndRun(db, "Ev-blocked", () => {
        runs += 1;
        return Promise.resolve();
      }),
    );
    expect(failure).toBe("claim failed");
    expect(runs).toBe(0);
  });
});
