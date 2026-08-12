export type ConversationSurface = "private" | "channel";

export interface ExpirySchedule {
  id: string;
  callback: string;
  payload: unknown;
  time: number;
}

export interface ExpiryPayload {
  surface: ConversationSurface;
}

interface Scheduler {
  listSchedules(): Promise<readonly ExpirySchedule[]>;
  cancelSchedule(id: string): Promise<boolean>;
  schedule(
    delaySeconds: number,
    callback: "expireConversation",
    payload: ExpiryPayload,
  ): Promise<ExpirySchedule>;
}

interface ExpiringAgent {
  listSchedules(): Promise<readonly ExpirySchedule[]>;
  destroy(): Promise<void>;
}

export async function replaceRetention(
  scheduler: Scheduler,
  surface: ConversationSurface,
  privateDays: number,
  channelDays: number,
): Promise<void> {
  const previous = await scheduler.listSchedules();
  const days = surface === "private" ? privateDays : channelDays;
  await scheduler.schedule(days * 86_400, "expireConversation", { surface });
  for (const schedule of previous) {
    if (schedule.callback === "expireConversation")
      await scheduler.cancelSchedule(schedule.id);
  }
}

export async function expireLatest(
  agent: ExpiringAgent,
  executing: ExpirySchedule,
): Promise<void> {
  const latest = (await agent.listSchedules())
    .filter((schedule) => schedule.callback === "expireConversation")
    .toSorted(
      (left, right) =>
        right.time - left.time || right.id.localeCompare(left.id),
    )[0];
  if (latest?.id === executing.id) await agent.destroy();
}

export interface ConversationLifecycleAgent extends Rpc.DurableObjectBranded {
  refreshRetention(surface: ConversationSurface): Promise<void>;
}

export async function refreshRetention(
  namespace: DurableObjectNamespace<ConversationLifecycleAgent>,
  id: string,
  surface: ConversationSurface,
): Promise<void> {
  await namespace.getByName(id).refreshRetention(surface);
}
