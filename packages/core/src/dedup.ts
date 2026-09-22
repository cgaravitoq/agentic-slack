const SEEN_EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const SWEEP_BATCH_LIMIT = 1000;

export const claimEvent = async (
  db: D1Database,
  eventId: string,
): Promise<boolean> => {
  const result = await db
    .prepare(
      "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch()) ON CONFLICT DO NOTHING",
    )
    .bind(eventId)
    .run();
  if (result.meta.changes === 0) {
    return false;
  }
  try {
    await db
      .prepare(
        "DELETE FROM seen_events WHERE rowid IN (SELECT rowid FROM seen_events WHERE created_at < unixepoch() - ?1 LIMIT ?2)",
      )
      .bind(SEEN_EVENT_RETENTION_SECONDS, SWEEP_BATCH_LIMIT)
      .run();
  } catch {
    // The claim already committed; propagating would fail the claim, so Slack's retry would deduplicate to changes === 0 and drop the event.
  }
  return true;
};

export const releaseEvent = async (
  db: D1Database,
  eventId: string,
): Promise<void> => {
  await db
    .prepare("DELETE FROM seen_events WHERE event_id = ?1")
    .bind(eventId)
    .run();
};

export const claimAndRun = async (
  db: D1Database,
  eventId: string,
  run: () => Promise<void>,
): Promise<void> => {
  if (!(await claimEvent(db, eventId))) {
    return;
  }
  try {
    await run();
  } catch (error) {
    await releaseEvent(db, eventId);
    throw error;
  }
};
