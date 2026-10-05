import * as v from "valibot";

const admissionRow = v.object({ admitted_by: v.string() });
const channelRow = v.object({ channel_id: v.string() });

export interface SlackChannelAdmissionStore {
  readonly admit: (
    channelId: string,
    inviterId: string,
    now: number,
  ) => Promise<void>;
  readonly admittedBy: (channelId: string) => Promise<string | undefined>;
  readonly drop: (channelId: string) => Promise<void>;
  readonly isAdmitted: (channelId: string) => Promise<boolean>;
}

export const createSqlSlackChannelAdmissionStore = (
  db: D1Database,
): SlackChannelAdmissionStore => ({
  async admit(channelId, inviterId, now) {
    await db
      .prepare(
        `INSERT INTO slack_channel_admissions (channel_id, admitted_by, admitted_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(channel_id) DO UPDATE SET admitted_by = excluded.admitted_by, admitted_at = excluded.admitted_at`,
      )
      .bind(channelId, inviterId, now)
      .run();
  },
  async admittedBy(channelId) {
    const { results } = await db
      .prepare(
        "SELECT admitted_by FROM slack_channel_admissions WHERE channel_id = ?1",
      )
      .bind(channelId)
      .all();
    const [row] = results;
    return v.is(admissionRow, row) ? row.admitted_by : undefined;
  },
  async drop(channelId) {
    await db
      .prepare("DELETE FROM slack_channel_admissions WHERE channel_id = ?1")
      .bind(channelId)
      .run();
  },
  async isAdmitted(channelId) {
    const { results } = await db
      .prepare(
        "SELECT channel_id FROM slack_channel_admissions WHERE channel_id = ?1",
      )
      .bind(channelId)
      .all();
    return results.some((row) => v.is(channelRow, row));
  },
});
