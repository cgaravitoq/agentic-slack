import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import {
  APPROVAL_TTL_SECONDS,
  createApprovalStore,
  createSqlSlackChannelAdmissionStore,
  createSqlSlackReadCursorStore,
} from "@agentic-slack/core";
import type { ApprovalRequest } from "@agentic-slack/core";
import {
  claimAndRun,
  claimEvent,
  releaseEvent,
} from "../../../packages/core/src/dedup.ts";
import {
  createSqlSlackProgressReceiptStore,
  createSqlSlackProgressRootStore,
} from "../../../packages/core/src/progress.ts";
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

const applyOrder = (entries: readonly string[]): string[] =>
  entries
    .filter((name) => name.endsWith(".sql"))
    .toSorted(compareMigrationPaths);

const migrationsDir = new URL("../migrations/", import.meta.url);
const migrationFiles = applyOrder(await readdir(migrationsDir));
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
  readonly batches: string[];
  readonly db: D1Database;
  readonly prepared: string[];
}

const migrated = (): MigratedDatabase => {
  const sqlite = new Database(":memory:");
  // wrangler d1 migrations apply runs one file per statement batch, in order.
  const batches: string[] = [];
  for (const source of migrationSources) {
    batches.push(source);
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
  return { batches, db, prepared };
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
      "0003_approval_requests.sql",
      "0004_slack_read_cursors.sql",
      "0005_slack_channel_admissions.sql",
      "0006_slack_progress_roots.sql",
      "0007_progress_receipts.sql",
      "0008_delegation.sql",
      "0009_progress_root_status.sql",
    ]);
    expect(
      applyOrder([
        "10_tenth.sql",
        "notes.md",
        "9_ninth.sql",
        "0002_second.sql",
      ]),
    ).toEqual(["0002_second.sql", "9_ninth.sql", "10_tenth.sql"]);
  });

  test("applies one statement batch per migration file", () => {
    const { batches } = migrated();
    expect(batches).toHaveLength(migrationFiles.length);
    expect(batches[0]).not.toContain("CREATE INDEX");
    expect(batches[1]).toContain("CREATE INDEX");
    expect(batches[2]).toContain(
      "CREATE TABLE IF NOT EXISTS approval_requests",
    );
    expect(batches[2]).toContain("CREATE INDEX");
    expect(batches[3]).toContain(
      "CREATE TABLE IF NOT EXISTS slack_read_cursors",
    );
    expect(batches[4]).toContain(
      "CREATE TABLE IF NOT EXISTS slack_channel_admissions",
    );
    expect(batches[5]).toContain(
      "CREATE TABLE IF NOT EXISTS slack_progress_roots",
    );
    expect(batches[6]).toContain("ALTER TABLE slack_progress_roots");
    expect(batches[6]).toContain(
      "CREATE TABLE IF NOT EXISTS progress_receipts",
    );
    expect(batches[6]).toContain("CREATE INDEX");
    expect(batches[8]).toContain(
      "ALTER TABLE slack_progress_roots ADD COLUMN status",
    );
  });

  test("adds the owned column to the roots stored before it", () => {
    const sqlite = new Database(":memory:");
    for (const source of migrationSources.slice(0, 6)) {
      sqlite.run(source);
    }
    sqlite.run(
      "INSERT INTO slack_progress_roots (channel_id, task_id, root_ts, root_text, updated_at) VALUES ('C1', 'task-1', '171.1', 'Release 42 · Started', 1)",
    );
    sqlite.run(migrationSources[6] ?? "");

    expect(
      sqlite
        .query(
          "SELECT channel_id, task_id, root_ts, root_text, owned FROM slack_progress_roots",
        )
        .all(),
    ).toEqual([
      {
        channel_id: "C1",
        owned: 1,
        root_text: "Release 42 · Started",
        root_ts: "171.1",
        task_id: "task-1",
      },
    ]);
  });

  test("leaves the status of the roots stored before it null", () => {
    const sqlite = new Database(":memory:");
    for (const source of migrationSources.slice(0, 8)) {
      sqlite.run(source);
    }
    sqlite.run(
      "INSERT INTO slack_progress_roots (channel_id, task_id, root_ts, root_text, owned, updated_at) VALUES ('C1', 'task-1', '171.1', 'Release 42 · Started', 1, 1)",
    );
    sqlite.run(migrationSources[8] ?? "");

    expect(
      sqlite
        .query("SELECT channel_id, task_id, status FROM slack_progress_roots")
        .all(),
    ).toEqual([{ channel_id: "C1", status: null, task_id: "task-1" }]);
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

    const claimNow = 1_700_000_000;
    expect(await claimEvent(db, "Ev-plan", claimNow)).toBe(true);
    const sweeps = prepared.filter((sql) => sql.startsWith("DELETE"));
    expect(sweeps).toHaveLength(1);

    const { results: plan } = await db
      .prepare(`EXPLAIN QUERY PLAN ${sweeps[0]}`)
      // The sweep binds a cutoff timestamp, not the retention window itself.
      .bind(claimNow - retentionSeconds, sweepBatchLimit)
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

  test("sweeps only rows older than the retention window, pinning the boundary second", async () => {
    const { db } = migrated();
    const now = 1_700_000_000;
    const seed = (eventId: string, createdAt: number) =>
      db
        .prepare(
          "INSERT INTO seen_events (event_id, created_at) VALUES (?1, ?2)",
        )
        .bind(eventId, createdAt)
        .run();
    await seed("Ev-expired", now - retentionSeconds - 1);
    await seed("Ev-boundary", now - retentionSeconds);
    await seed("Ev-recent", now - retentionSeconds + 1);

    expect(await claimEvent(db, "Ev-claimed", now)).toBe(true);

    // The claim stamps the injected clock as created_at, not the wall clock: a
    // row written with unixepoch() would outlive the sweep and quietly move the
    // boundary this test pins.
    const { results: claimed } = await db
      .prepare(
        "SELECT created_at FROM seen_events WHERE event_id = 'Ev-claimed'",
      )
      .all();
    expect(claimed).toEqual([{ created_at: now }]);

    const { results } = await db
      .prepare("SELECT event_id FROM seen_events ORDER BY event_id")
      .all();
    expect(results).toEqual([
      { event_id: "Ev-boundary" },
      { event_id: "Ev-claimed" },
      { event_id: "Ev-recent" },
    ]);
  });

  test("sweeps against the wall clock in seconds when no clock is injected", async () => {
    const { db } = migrated();
    const seed = (eventId: string, age: number) =>
      db
        .prepare(
          "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch() - ?2)",
        )
        .bind(eventId, age)
        .run();
    await seed("Ev-expired", retentionSeconds + 60);
    await seed("Ev-recent", retentionSeconds - 60);

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
    const now = 1_700_000_000;
    const stale = sweepBatchLimit + 2;
    await db
      .prepare(
        "INSERT INTO seen_events (event_id, created_at) WITH RECURSIVE counter(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < ?2) SELECT 'Ev-stale-' || i, ?1 FROM counter",
      )
      .bind(now - retentionSeconds - 1, stale)
      .run();

    expect(await claimEvent(db, "Ev-batch", now)).toBe(true);
    expect(await staleCount(db)).toEqual([{ stale: stale - sweepBatchLimit }]);

    const { results: survivors } = await db
      .prepare(
        "SELECT event_id FROM seen_events WHERE event_id LIKE 'Ev-stale-%' ORDER BY rowid",
      )
      .all();
    expect(survivors).toHaveLength(stale - sweepBatchLimit);
    expect(await claimEvent(db, String(survivors[0].event_id), now)).toBe(
      false,
    );
    expect(await staleCount(db)).toEqual([{ stale: stale - sweepBatchLimit }]);

    expect(await claimEvent(db, "Ev-batch-again", now)).toBe(true);
    expect(await staleCount(db)).toEqual([{ stale: 0 }]);
  });

  test("runs the claimed handler and reports the sweep failure by name", async () => {
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

    const reported: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      reported.push(args);
    };
    let runs = 0;
    try {
      await claimAndRun(db, "Ev-sweep", () => {
        runs += 1;
        return Promise.resolve();
      });
    } finally {
      console.error = originalError;
    }

    expect(runs).toBe(1);
    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toBe("seen_events retention sweep failed");
    expect(reported[0][1]).toBeInstanceOf(Error);
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

const NOW = 1_700_000_000;

const pendingApproval = (
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  appId: "A1",
  args: '{"domain":"acme.test"}',
  channelId: "D1",
  conversationId: "slack:v1:T1:D1:D1",
  createdAt: NOW,
  expiresAt: NOW + APPROVAL_TTL_SECONDS,
  messageTs: "171.2",
  requestId: "req-1",
  requesterId: "U1",
  state: "pending",
  surface: "private",
  teamId: "T1",
  threadTs: "171.1",
  tool: "create_organization",
  ...overrides,
});

const approvalRows = async (db: D1Database): Promise<unknown[]> => {
  const { results } = await db
    .prepare(
      "SELECT request_id, state, decided_by, message_ts FROM approval_requests ORDER BY request_id",
    )
    .all();
  return results;
};

describe("approval request storage", () => {
  test("decides a pending request once and refuses every later decision", async () => {
    const { db } = migrated();
    const store = createApprovalStore(db);
    await store.create(pendingApproval());

    expect(await store.decide("req-1", "approved", "U1", NOW)).toBe(true);
    expect(await store.decide("req-1", "rejected", "U2", NOW)).toBe(false);
    expect(await store.decide("req-1", "approved", "U1", NOW)).toBe(false);

    expect(await approvalRows(db)).toEqual([
      {
        decided_by: "U1",
        message_ts: "171.2",
        request_id: "req-1",
        state: "approved",
      },
    ]);
  });

  test("gives an approval a full window from the click and keeps a rejection on the request window", async () => {
    const { db } = migrated();
    const store = createApprovalStore(db);
    const lateClick = NOW + APPROVAL_TTL_SECONDS - 10;
    await store.create(pendingApproval({ requestId: "req-approved" }));
    await store.create(pendingApproval({ requestId: "req-rejected" }));

    await store.decide("req-approved", "approved", "U1", lateClick);
    await store.decide("req-rejected", "rejected", "U1", lateClick);

    const approved = await store.read("req-approved");
    const rejected = await store.read("req-rejected");
    expect(approved?.expiresAt).toBe(lateClick + APPROVAL_TTL_SECONDS);
    expect(rejected?.expiresAt).toBe(NOW + APPROVAL_TTL_SECONDS);
  });

  test("executes an approved request exactly once and never a pending or rejected one", async () => {
    const { db } = migrated();
    const store = createApprovalStore(db);
    await store.create(pendingApproval({ requestId: "req-pending" }));
    await store.create(pendingApproval({ requestId: "req-rejected" }));
    await store.create(pendingApproval({ requestId: "req-approved" }));

    expect(await store.claim("req-pending")).toBe(false);
    expect(await store.decide("req-rejected", "rejected", "U1", NOW)).toBe(
      true,
    );
    expect(await store.claim("req-rejected")).toBe(false);
    expect(await store.decide("req-approved", "approved", "U1", NOW)).toBe(
      true,
    );
    expect(await store.claim("req-approved")).toBe(true);
    expect(await store.claim("req-approved")).toBe(false);

    expect(await approvalRows(db)).toEqual([
      {
        decided_by: "U1",
        message_ts: "171.2",
        request_id: "req-approved",
        state: "executed",
      },
      {
        decided_by: null,
        message_ts: "171.2",
        request_id: "req-pending",
        state: "pending",
      },
      {
        decided_by: "U1",
        message_ts: "171.2",
        request_id: "req-rejected",
        state: "rejected",
      },
    ]);
  });

  test("finds only the newest request for one exact call in one conversation", async () => {
    const { db } = migrated();
    const store = createApprovalStore(db);
    await store.create(
      pendingApproval({ createdAt: NOW - 60, requestId: "req-old" }),
    );
    await store.create(pendingApproval({ requestId: "req-new" }));
    await store.create(
      pendingApproval({
        args: '{"domain":"other.test"}',
        requestId: "req-other-args",
      }),
    );
    await store.create(
      pendingApproval({
        conversationId: "slack:v1:T1:D2:D2",
        requestId: "req-other-conversation",
      }),
    );

    const newest = await store.latest(
      "slack:v1:T1:D1:D1",
      "create_organization",
      '{"domain":"acme.test"}',
    );
    expect(newest?.requestId).toBe("req-new");
    expect(
      await store.latest(
        "slack:v1:T1:D1:D1",
        "create_organization",
        '{"domain":"absent.test"}',
      ),
    ).toBeUndefined();
    expect(
      await store.latest(
        "slack:v1:T1:D1:D1",
        "delete_organization",
        '{"domain":"acme.test"}',
      ),
    ).toBeUndefined();
  });

  test("plans the exact-call lookup through the approval index", async () => {
    const { db, prepared } = migrated();
    const store = createApprovalStore(db);
    await store.create(pendingApproval());
    await store.latest(
      "slack:v1:T1:D1:D1",
      "create_organization",
      '{"domain":"acme.test"}',
    );

    const lookup = prepared.find((sql) =>
      sql.includes("FROM approval_requests WHERE conversation_id"),
    );
    expect(lookup).toBeDefined();

    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${lookup ?? ""}`)
      .bind(
        "slack:v1:T1:D1:D1",
        "create_organization",
        '{"domain":"acme.test"}',
      )
      .all();
    const details = results.map((step) => step.detail);
    expect(details).toContain(
      "SEARCH approval_requests USING INDEX idx_approval_requests_lookup (conversation_id=? AND tool=?)",
    );
    expect(details).not.toContain("SCAN approval_requests");
  });

  test("keeps the card timestamp and reads one request by id", async () => {
    const { db } = migrated();
    const store = createApprovalStore(db);
    await store.create(pendingApproval({ messageTs: "" }));
    await store.attachMessage("req-1", "171.4");

    const attached = await store.read("req-1");
    expect(attached?.messageTs).toBe("171.4");
    expect(await store.read("req-absent")).toBeUndefined();
  });

  test("sweeps only the requests that left the retention window", async () => {
    const { db } = migrated();
    const store = createApprovalStore(db);
    const retention = 7 * 24 * 60 * 60;
    const longAgo = NOW - 2 * retention;
    await store.create(
      pendingApproval({
        createdAt: longAgo,
        expiresAt: NOW - retention - 1,
        requestId: "req-expired",
      }),
    );
    await store.create(
      pendingApproval({
        createdAt: longAgo,
        expiresAt: NOW - retention,
        requestId: "req-boundary",
      }),
    );
    await store.create(pendingApproval({ requestId: "req-live" }));

    expect(await approvalRows(db)).toEqual([
      {
        decided_by: null,
        message_ts: "171.2",
        request_id: "req-boundary",
        state: "pending",
      },
      {
        decided_by: null,
        message_ts: "171.2",
        request_id: "req-live",
        state: "pending",
      },
    ]);
  });
});

describe("slack read cursor storage", () => {
  test("keeps one watermark per channel and reads it back", async () => {
    const { db } = migrated();
    const store = createSqlSlackReadCursorStore(db);

    expect(await store.load("C1")).toBeUndefined();
    await store.save("C1", "1800000000.000000", NOW);
    await store.save("C2", "1799999000.000000", NOW);
    await store.save("C1", "1800000001.000000", NOW);

    expect(await store.load("C1")).toBe("1800000001.000000");
    expect(await store.load("C2")).toBe("1799999000.000000");
    expect(await store.load("C3")).toBeUndefined();

    const rows = await db
      .prepare(
        "SELECT channel_id, cursor_ts, updated_at FROM slack_read_cursors ORDER BY channel_id",
      )
      .all();
    expect(rows.results).toEqual([
      { channel_id: "C1", cursor_ts: "1800000001.000000", updated_at: NOW },
      { channel_id: "C2", cursor_ts: "1799999000.000000", updated_at: NOW },
    ]);
  });
});

describe("slack progress root storage", () => {
  test("keeps one root per task in a channel and updates it in place", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressRootStore(db);

    expect(await store.load("C1", "task-1")).toBeUndefined();
    await store.save(
      "C1",
      "task-1",
      { owned: true, rootText: "Release 42 · Started", rootTs: "171.1" },
      NOW,
    );
    await store.save(
      "C1",
      "task-2",
      { owned: true, rootText: "Release 43 · Started", rootTs: "171.2" },
      NOW,
    );
    await store.save(
      "C1",
      "task-1",
      { owned: true, rootText: "Release 42 · Blocked", rootTs: "171.1" },
      NOW + 60,
    );

    expect(await store.load("C1", "task-1")).toEqual({
      owned: true,
      rootText: "Release 42 · Blocked",
      rootTs: "171.1",
    });
    expect(await store.load("C1", "task-2")).toEqual({
      owned: true,
      rootText: "Release 43 · Started",
      rootTs: "171.2",
    });
    expect(await store.load("C2", "task-1")).toBeUndefined();

    await store.drop("C1", "task-1");
    await store.drop("C1", "task-9");
    expect(await store.load("C1", "task-1")).toBeUndefined();
    expect(await store.load("C1", "task-2")).toEqual({
      owned: true,
      rootText: "Release 43 · Started",
      rootTs: "171.2",
    });

    const rows = await db
      .prepare(
        "SELECT channel_id, task_id, root_ts, root_text, owned, updated_at FROM slack_progress_roots ORDER BY channel_id, task_id",
      )
      .all();
    expect(rows.results).toEqual([
      {
        channel_id: "C1",
        owned: 1,
        root_text: "Release 43 · Started",
        root_ts: "171.2",
        task_id: "task-2",
        updated_at: NOW,
      },
    ]);
  });

  test("keeps a root a thread the bot does not own adopted", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressRootStore(db);

    await store.save(
      "C1",
      "task-1",
      { owned: false, rootText: "Release 42 · Started", rootTs: "171.1" },
      NOW,
    );

    expect(await store.load("C1", "task-1")).toEqual({
      owned: false,
      rootText: "Release 42 · Started",
      rootTs: "171.1",
    });
  });

  test("keeps the latest status of a root and leaves a root stored without one without a status", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressRootStore(db);

    await store.save(
      "C1",
      "task-1",
      { owned: true, rootText: "Release 42 · Started", rootTs: "171.1" },
      NOW,
    );
    expect(await store.load("C1", "task-1")).toEqual({
      owned: true,
      rootText: "Release 42 · Started",
      rootTs: "171.1",
    });

    await store.save(
      "C1",
      "task-1",
      {
        owned: true,
        rootText: "Release 42 · Started · 2 of 5 landed",
        rootTs: "171.1",
        status: "2 of 5 landed",
      },
      NOW + 60,
    );
    expect(await store.load("C1", "task-1")).toEqual({
      owned: true,
      rootText: "Release 42 · Started · 2 of 5 landed",
      rootTs: "171.1",
      status: "2 of 5 landed",
    });

    const { results } = await db
      .prepare(
        "SELECT channel_id, task_id, status FROM slack_progress_roots ORDER BY channel_id, task_id",
      )
      .all();
    expect(results).toEqual([
      { channel_id: "C1", status: "2 of 5 landed", task_id: "task-1" },
    ]);
  });
});

const receiptRows = async (db: D1Database): Promise<unknown[]> => {
  const { results } = await db
    .prepare(
      "SELECT milestone_id, state, ts, claimed_at FROM progress_receipts ORDER BY milestone_id",
    )
    .all();
  return results;
};

describe("progress receipt storage", () => {
  test("claims a milestone once, holds the duplicate busy, and settles it with the reply timestamp", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressReceiptStore(db);

    expect(await store.claim("evt-1", NOW)).toEqual({ outcome: "claimed" });
    expect(await store.claim("evt-1", NOW + 1)).toEqual({ outcome: "busy" });

    await store.complete("evt-1", { state: "posted", ts: "171.1" }, NOW + 2);

    expect(await store.claim("evt-1", NOW + 3)).toEqual({
      outcome: "settled",
      receipt: { state: "posted", ts: "171.1" },
    });
    expect(await receiptRows(db)).toEqual([
      { claimed_at: NOW, milestone_id: "evt-1", state: "posted", ts: "171.1" },
    ]);
  });

  test("settles a narrated milestone without a timestamp", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressReceiptStore(db);

    await store.complete("evt-1", { state: "narrated" }, NOW);

    expect(await store.claim("evt-1", NOW + 1)).toEqual({
      outcome: "settled",
      receipt: { state: "narrated" },
    });
    expect(await receiptRows(db)).toEqual([
      { claimed_at: NOW, milestone_id: "evt-1", state: "narrated", ts: null },
    ]);
  });

  test("reclaims a claim older than the lease and refuses a younger one", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressReceiptStore(db);

    await store.claim("evt-1", NOW);

    expect(await store.claim("evt-1", NOW + 299)).toEqual({ outcome: "busy" });
    expect(await store.claim("evt-1", NOW + 301)).toEqual({
      outcome: "claimed",
    });
    expect(await receiptRows(db)).toEqual([
      {
        claimed_at: NOW + 301,
        milestone_id: "evt-1",
        state: "in_flight",
        ts: null,
      },
    ]);
  });

  test("drops a failed milestone so its retry claims it again", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressReceiptStore(db);

    await store.claim("evt-1", NOW);
    await store.drop("evt-1");

    expect(await store.claim("evt-1", NOW + 1)).toEqual({ outcome: "claimed" });
  });

  test("sweeps only the receipts that left the retention window", async () => {
    const { db } = migrated();
    const store = createSqlSlackProgressReceiptStore(db);

    await store.claim("Ev-stale", NOW - retentionSeconds - 1);
    await store.claim("Ev-fresh", NOW);

    await store.claim("Ev-trigger", NOW + 1);

    const { results } = await db
      .prepare(
        "SELECT milestone_id FROM progress_receipts ORDER BY milestone_id",
      )
      .all();
    expect(results).toEqual([
      { milestone_id: "Ev-fresh" },
      { milestone_id: "Ev-trigger" },
    ]);
  });
});

describe("slack channel admission storage", () => {
  test("admits a channel once and drops it on a later refusal", async () => {
    const { db } = migrated();
    const store = createSqlSlackChannelAdmissionStore(db);

    expect(await store.isAdmitted("C1")).toBe(false);
    await store.admit("C1", "U111", NOW);
    await store.admit("C2", "U222", NOW);
    expect(await store.isAdmitted("C1")).toBe(true);
    expect(await store.isAdmitted("C2")).toBe(true);
    expect(await store.admittedBy("C1")).toBe("U111");
    expect(await store.admittedBy("C3")).toBeUndefined();

    await store.admit("C1", "U111", NOW + 60);
    await store.drop("C2");
    await store.drop("C3");

    expect(await store.isAdmitted("C1")).toBe(true);
    expect(await store.isAdmitted("C2")).toBe(false);
    expect(await store.admittedBy("C1")).toBe("U111");

    const rows = await db
      .prepare(
        "SELECT channel_id, admitted_by, admitted_at FROM slack_channel_admissions ORDER BY channel_id",
      )
      .all();
    expect(rows.results).toEqual([
      { admitted_at: NOW + 60, admitted_by: "U111", channel_id: "C1" },
    ]);
  });
});
