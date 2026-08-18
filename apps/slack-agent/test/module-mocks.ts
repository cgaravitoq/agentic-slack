import { mock } from "bun:test";

// Bun freezes a specifier's export list the first time it is mocked, so a mock
// narrower than the real module breaks whichever test file loads next and the
// breakage only shows up in one test-file order. Each specifier that cannot
// simply spread the real module is shaped here once, so two test files can
// never disagree about its exports.

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
};
