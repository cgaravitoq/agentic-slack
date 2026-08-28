import { mock } from "bun:test";
import type { ExpiryPayload, ExpirySchedule } from "@agentic-slack/core";

// Bun freezes a specifier's export list the first time it is mocked, so a mock
// narrower than the real module breaks whichever test file loads next and the
// breakage only shows up in one test-file order. Each specifier that cannot
// simply spread the real module is shaped here once, so two test files can
// never disagree about its exports.

type RetentionClassFactory = <TBase extends new () => RetentionHost>(
  Base: TBase,
) => new () => InstanceType<TBase> & {
  expireConversation: (
    payload: ExpiryPayload,
    schedule: ExpirySchedule,
  ) => Promise<void>;
  refreshRetention: (surface: "private" | "channel") => Promise<void>;
};

export interface CapturedCloudflareExtension {
  base?: RetentionClassFactory;
}

interface RetentionHost {
  cancelSchedule: (id: string) => Promise<boolean>;
  destroy: () => Promise<void>;
  listSchedules: () => Promise<readonly ExpirySchedule[]>;
  schedule: (
    delaySeconds: number,
    callback: "expireConversation",
    payload: ExpiryPayload,
  ) => Promise<ExpirySchedule>;
}

interface RetentionExtendCapture {
  extension?: CapturedCloudflareExtension;
}

export const retentionExtendCapture: RetentionExtendCapture = {};

// `cloudflare:workers` has no importable implementation outside workerd, so its
// export list and the bindings a test may stand in for are declared here.
export interface MockedWorkerEnv {
  AI?: unknown;
  EXTENSION_SECRET?: string;
  SLACK_APP_ID?: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_TEAM_ID?: string;
}

export const mockCloudflareWorkers = async (
  env: MockedWorkerEnv,
): Promise<void> => {
  await mock.module("cloudflare:workers", () => ({ env }));
};

export const mockWorkersAi = async (): Promise<void> => {
  const workersAi = await import("@flue/runtime/cloudflare/workers-ai");
  await mock.module("@flue/runtime/cloudflare/workers-ai", () => ({
    ...workersAi,
    cloudflareBindingProvider: () => ({}),
  }));
  const cloudflare = await import("@flue/runtime/cloudflare");
  await mock.module("@flue/runtime/cloudflare", () => ({
    ...cloudflare,
    extend: (extension: CapturedCloudflareExtension) => {
      retentionExtendCapture.extension = extension;
      return { base: undefined };
    },
  }));
};
