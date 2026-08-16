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
  listSchedules: () => Promise<readonly ExpirySchedule[]>;
  cancelSchedule: (id: string) => Promise<boolean>;
  schedule: (
    delaySeconds: number,
    callback: "expireConversation",
    payload: ExpiryPayload,
  ) => Promise<ExpirySchedule>;
}

interface ExpiringAgent {
  listSchedules: () => Promise<readonly ExpirySchedule[]>;
  destroy: () => Promise<void>;
}

export const replaceRetention = async (
  scheduler: Scheduler,
  surface: ConversationSurface,
  privateDays: number,
  channelDays: number,
): Promise<void> => {
  const previous = await scheduler.listSchedules();
  const days = surface === "private" ? privateDays : channelDays;
  await scheduler.schedule(days * 86_400, "expireConversation", { surface });
  await Promise.all(
    previous
      .filter((schedule) => schedule.callback === "expireConversation")
      .map((schedule) => scheduler.cancelSchedule(schedule.id)),
  );
};

export const expireLatest = async (
  agent: ExpiringAgent,
  executing: ExpirySchedule,
): Promise<void> => {
  const schedules = await agent.listSchedules();
  const [latest] = schedules
    .filter((schedule) => schedule.callback === "expireConversation")
    .toSorted(
      (left, right) =>
        right.time - left.time || right.id.localeCompare(left.id),
    );
  if (latest?.id === executing.id) {
    await agent.destroy();
  }
};

export interface ConversationLifecycleAgent extends Rpc.DurableObjectBranded {
  refreshRetention: (surface: ConversationSurface) => Promise<void>;
}

export const refreshRetention = async (
  namespace: DurableObjectNamespace<ConversationLifecycleAgent>,
  id: string,
  surface: ConversationSurface,
): Promise<void> => {
  await namespace.getByName(id).refreshRetention(surface);
};
