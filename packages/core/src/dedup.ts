const SEEN_EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export async function claimEvent(
  db: D1Database,
  eventId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO seen_events (event_id, created_at) VALUES (?1, unixepoch()) ON CONFLICT DO NOTHING",
    )
    .bind(eventId)
    .run();
  if (result.meta.changes === 0) return false;
  await db
    .prepare("DELETE FROM seen_events WHERE created_at < unixepoch() - ?1")
    .bind(SEEN_EVENT_RETENTION_SECONDS)
    .run();
  return true;
}

export async function releaseEvent(
  db: D1Database,
  eventId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM seen_events WHERE event_id = ?1")
    .bind(eventId)
    .run();
}

export async function claimAndRun(
  db: D1Database,
  eventId: string,
  run: () => Promise<void>,
): Promise<void> {
  if (!(await claimEvent(db, eventId))) return;
  try {
    await run();
  } catch (error) {
    await releaseEvent(db, eventId);
    throw error;
  }
}
