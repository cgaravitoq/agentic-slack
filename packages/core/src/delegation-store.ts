import { createHash, randomBytes } from "node:crypto";
import * as v from "valibot";

const taskState = v.picklist([
  "proposed",
  "approved",
  "claimed",
  "running",
  "done",
  "failed",
  "unknown",
  "expired",
  "cancelled",
]);
const rawMessage = v.object({
  author: v.string(),
  permalink: v.string(),
  text: v.string(),
  ts: v.string(),
});
export interface DelegationTask {
  id: string;
  repo: string;
  channel: string;
  threadTs: string;
  requester: string;
  reporters: string[];
  title: string;
  summary: string;
  rawThread: v.InferOutput<typeof rawMessage>[];
  state: v.InferOutput<typeof taskState>;
  expiresAt: number;
}
export const runnerSchema = v.object({
  capacity: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(100)),
  repos: v.array(v.pipe(v.string(), v.nonEmpty())),
  url: v.pipe(
    v.string(),
    v.url(),
    v.check((url) => new URL(url).protocol === "https:"),
  ),
});
export type DelegationRunner = v.InferOutput<typeof runnerSchema>;
const rowSchema = v.object({
  channel: v.string(),
  expires_at: v.number(),
  id: v.string(),
  instance_id: v.string(),
  raw_thread: v.string(),
  repo: v.string(),
  reporters: v.string(),
  requester: v.string(),
  runner: v.nullable(v.string()),
  state: taskState,
  summary: v.string(),
  thread_ts: v.string(),
  title: v.string(),
  token_hash: v.nullable(v.string()),
});
export interface StoredDelegationTask {
  task: DelegationTask;
  runner: string | null;
  tokenHash: string | null;
  instanceId: string;
}
const storedTask = (
  row: v.InferOutput<typeof rowSchema>,
): StoredDelegationTask => ({
  instanceId: row.instance_id,
  runner: row.runner,
  task: {
    channel: row.channel,
    expiresAt: row.expires_at,
    id: row.id,
    rawThread: v.parse(v.array(rawMessage), JSON.parse(row.raw_thread)),
    repo: row.repo,
    reporters: v.parse(v.array(v.string()), JSON.parse(row.reporters)),
    requester: row.requester,
    state: row.state,
    summary: row.summary,
    threadTs: row.thread_ts,
    title: row.title,
  },
  tokenHash: row.token_hash,
});
const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const createDelegationStore = (db: D1Database) => {
  const read = async (
    id: string,
  ): Promise<StoredDelegationTask | undefined> => {
    const { results } = await db
      .prepare("SELECT * FROM delegation_tasks WHERE id = ?1")
      .bind(id)
      .all();
    return results[0] === undefined
      ? undefined
      : storedTask(v.parse(rowSchema, results[0]));
  };
  return {
    async approve(
      id: string,
      runner: string,
      requester: string,
      now = Date.now(),
    ): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE delegation_tasks SET state = 'approved', runner = ?2 WHERE id = ?1 AND state = 'proposed' AND runner IS NULL AND requester = ?3 AND expires_at > ?4 AND EXISTS (SELECT 1 FROM delegation_runners, json_each(delegation_runners.repos) WHERE delegation_runners.name = ?2 AND json_each.value = delegation_tasks.repo)",
        )
        .bind(id, runner, requester, now)
        .run();
      return result.meta.changes === 1;
    },
    async approved(
      runner: string,
      now = Date.now(),
    ): Promise<DelegationTask[]> {
      const { results } = await db
        .prepare(
          "SELECT * FROM delegation_tasks WHERE runner = ?1 AND state = 'approved' AND expires_at > ?2 ORDER BY expires_at",
        )
        .bind(runner, now)
        .all();
      return results.map((row) => storedTask(v.parse(rowSchema, row)).task);
    },
    async cancel(id: string, requester: string): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE delegation_tasks SET state = 'cancelled' WHERE id = ?1 AND requester = ?2 AND state IN ('proposed', 'approved')",
        )
        .bind(id, requester)
        .run();
      return result.meta.changes === 1;
    },
    async claim(
      id: string,
      runner: string,
      now = Date.now(),
    ): Promise<
      { task: DelegationTask; token: string; instanceId: string } | undefined
    > {
      const stored = await read(id);
      if (
        stored === undefined ||
        stored.runner !== runner ||
        !(
          stored.task.state === "claimed" ||
          (stored.task.state === "approved" && stored.task.expiresAt > now)
        )
      ) {
        return undefined;
      }
      const token = randomBytes(32).toString("base64url");
      const result = await db
        .prepare(
          "UPDATE delegation_tasks SET state = 'claimed', token_hash = ?3 WHERE id = ?1 AND runner = ?2 AND state = ?4 AND token_hash IS ?5 AND (state = 'claimed' OR expires_at > ?6)",
        )
        .bind(
          id,
          runner,
          hashToken(token),
          stored.task.state,
          stored.tokenHash,
          now,
        )
        .run();
      return result.meta.changes === 1
        ? {
            instanceId: stored.instanceId,
            task: { ...stored.task, state: "claimed" },
            token,
          }
        : undefined;
    },
    async complete(
      id: string,
      tokenHash: string,
      milestoneId: string,
      ts: string,
    ): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      await db.batch([
        db
          .prepare(
            "UPDATE progress_receipts SET state = 'posted', ts = ?2, updated_at = ?3 WHERE milestone_id = ?1 AND state = 'in_flight'",
          )
          .bind(milestoneId, ts, now),
        db
          .prepare(
            "UPDATE delegation_tasks SET state = 'done' WHERE id = ?1 AND token_hash = ?2 AND state IN ('claimed', 'running', 'unknown') AND EXISTS (SELECT 1 FROM progress_receipts WHERE milestone_id = ?3 AND state = 'posted' AND ts = ?4)",
          )
          .bind(id, tokenHash, milestoneId, ts),
      ]);
    },
    async expire(id: string, now = Date.now()): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE delegation_tasks SET state = 'expired' WHERE id = ?1 AND state IN ('proposed', 'approved') AND expires_at <= ?2",
        )
        .bind(id, now)
        .run();
      return result.meta.changes === 1;
    },
    async propose(task: DelegationTask, instanceId: string): Promise<void> {
      await db
        .prepare(
          "INSERT INTO delegation_tasks (id, repo, channel, thread_ts, requester, reporters, title, summary, raw_thread, state, expires_at, instance_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'proposed', ?10, ?11)",
        )
        .bind(
          task.id,
          task.repo,
          task.channel,
          task.threadTs,
          task.requester,
          JSON.stringify(task.reporters),
          task.title,
          task.summary,
          JSON.stringify(task.rawThread),
          task.expiresAt,
          instanceId,
        )
        .run();
    },
    read,
    async register(runner: DelegationRunner): Promise<void> {
      await db
        .prepare(
          "INSERT INTO delegation_runners (name, url, repos, capacity) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(name) DO UPDATE SET url = excluded.url, repos = excluded.repos, capacity = excluded.capacity",
        )
        .bind(
          runner.name,
          runner.url,
          JSON.stringify(runner.repos),
          runner.capacity,
        )
        .run();
    },
    async runners(): Promise<DelegationRunner[]> {
      const { results } = await db
        .prepare("SELECT * FROM delegation_runners ORDER BY name")
        .all();
      return results.map((entry) => {
        const row = v.parse(
          v.object({
            capacity: v.number(),
            name: v.string(),
            repos: v.string(),
            url: v.string(),
          }),
          entry,
        );
        return v.parse(runnerSchema, {
          ...row,
          repos: v.parse(v.array(v.string()), JSON.parse(row.repos)),
        });
      });
    },
    async tokenTask(token: string): Promise<StoredDelegationTask | undefined> {
      const { results } = await db
        .prepare(
          "SELECT * FROM delegation_tasks WHERE token_hash = ?1 AND state IN ('claimed', 'running', 'unknown')",
        )
        .bind(hashToken(token))
        .all();
      return results[0] === undefined
        ? undefined
        : storedTask(v.parse(rowSchema, results[0]));
    },
    async transition(
      id: string,
      runner: string,
      state: "running" | "failed" | "unknown",
    ): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE delegation_tasks SET state = ?3 WHERE id = ?1 AND runner = ?2 AND (state IN ('claimed', 'running') OR (state = 'unknown' AND ?3 = 'failed'))",
        )
        .bind(id, runner, state)
        .run();
      return result.meta.changes === 1;
    },
  };
};
