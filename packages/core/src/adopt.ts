import path from "node:path";
import * as v from "valibot";
import { defineAgentConfig } from "./config.ts";
import { verifyDatabase } from "./d1.ts";
import { readInstance } from "./instance.ts";
import {
  lockFileName,
  manifestSha256,
  readLock,
  withLockEnvironment,
  writeLock,
} from "./lock.ts";
import { generateSlackManifest } from "./manifest.ts";
import { configToken } from "./slack-app.ts";
import { runWrangler } from "./wrangler.ts";

export interface AdoptOptions {
  appId?: string;
  d1Id?: string;
  directory: string;
  environment: string;
}

const verifyWorker = async (
  worker: string,
  directory: string,
): Promise<void> => {
  try {
    await runWrangler(["deployments", "list", "--name", worker, "--json"], {
      cwd: directory,
    });
  } catch (error) {
    throw new Error(
      `Cloudflare has no Worker ${worker} in this account: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};
const manifestSchema = v.object({
  oauth_config: v.optional(
    v.object({
      scopes: v.optional(v.object({ bot: v.optional(v.array(v.string())) })),
    }),
  ),
  settings: v.optional(
    v.object({
      event_subscriptions: v.optional(
        v.object({
          bot_events: v.optional(v.array(v.string())),
          request_url: v.optional(v.string()),
        }),
      ),
      interactivity: v.optional(
        v.object({
          is_enabled: v.optional(v.boolean()),
          request_url: v.optional(v.string()),
        }),
      ),
    }),
  ),
});

const manifestExportSchema = v.object({
  error: v.optional(v.string()),
  manifest: v.optional(manifestSchema),
  ok: v.optional(v.boolean()),
});

interface ManifestComparison {
  botEvents: readonly string[];
  botScopes: readonly string[];
  eventsUrl: string | undefined;
  interactivityEnabled: boolean;
  interactivityUrl: string | undefined;
}

const manifestComparison = (
  manifest: v.InferOutput<typeof manifestSchema>,
): ManifestComparison => ({
  botEvents: manifest.settings?.event_subscriptions?.bot_events ?? [],
  botScopes: manifest.oauth_config?.scopes?.bot ?? [],
  eventsUrl: manifest.settings?.event_subscriptions?.request_url,
  interactivityEnabled: manifest.settings?.interactivity?.is_enabled ?? false,
  interactivityUrl: manifest.settings?.interactivity?.request_url,
});

const exportManifest = async (
  token: string,
  appId: string,
): Promise<ManifestComparison> => {
  const response = await fetch("https://slack.com/api/apps.manifest.export", {
    body: new URLSearchParams({ app_id: appId }).toString(),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  const result = v.parse(manifestExportSchema, await response.json());
  if (result.ok !== true) {
    throw new Error(
      `Slack refused to export the manifest of ${appId}: ${result.error ?? "unknown error"}`,
    );
  }
  if (result.manifest === undefined) {
    throw new Error(`Slack returned no manifest for ${appId}`);
  }
  return manifestComparison(result.manifest);
};

const listDifference = (
  label: string,
  expected: readonly string[],
  actual: readonly string[],
): readonly string[] => {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const unexpected = actual.filter((entry) => !expected.includes(entry));
  return [
    ...(missing.length === 0
      ? []
      : [`${label}: missing ${missing.join(", ")}`]),
    ...(unexpected.length === 0
      ? []
      : [`${label}: unexpected ${unexpected.join(", ")}`]),
  ];
};

const manifestDifferences = (
  generated: string,
  actual: ManifestComparison,
): readonly string[] => {
  const expected = manifestComparison(
    v.parse(manifestSchema, JSON.parse(generated)),
  );
  const differences = [
    ...listDifference("bot scopes", expected.botScopes, actual.botScopes),
    ...listDifference("bot events", expected.botEvents, actual.botEvents),
  ];
  if (expected.eventsUrl !== actual.eventsUrl) {
    differences.push(
      `events request URL: the app has ${actual.eventsUrl ?? "none"}, the manifest asks for ${expected.eventsUrl ?? "none"}`,
    );
  }
  if (expected.interactivityEnabled !== actual.interactivityEnabled) {
    differences.push(
      `interactivity: the app has it ${actual.interactivityEnabled ? "enabled" : "disabled"}, the manifest asks for it ${expected.interactivityEnabled ? "enabled" : "disabled"}`,
    );
  } else if (
    expected.interactivityEnabled &&
    expected.interactivityUrl !== actual.interactivityUrl
  ) {
    differences.push(
      `interactivity request URL: the app has ${actual.interactivityUrl ?? "none"}, the manifest asks for ${expected.interactivityUrl ?? "none"}`,
    );
  }
  return differences;
};

export const adopt = async (options: AdoptOptions): Promise<string> => {
  const { directory, environment: environmentName } = options;
  const instance = await readInstance(directory);
  const environment = instance.environments[environmentName];
  if (environment === undefined) {
    throw new Error(`agent.yaml has no environment ${environmentName}`);
  }
  const lock = await readLock(directory);
  const locked = lock.environments[environmentName];
  const d1Id = options.d1Id ?? locked?.d1.id ?? environment.d1.id;
  if (d1Id === undefined) {
    throw new Error(
      `agent.yaml has no environments.${environmentName}.d1.id: pass --d1-id <id>`,
    );
  }
  const appId =
    options.appId ?? locked?.slack?.appId ?? environment.vars.SLACK_APP_ID;
  if (appId === undefined) {
    throw new Error(
      `agent.yaml has no environments.${environmentName}.vars.SLACK_APP_ID: pass --app-id <id>`,
    );
  }
  await verifyDatabase({ id: d1Id, name: environment.d1.name }, directory);
  await verifyWorker(environment.worker, directory);
  const manifest = generateSlackManifest(
    defineAgentConfig({ ...instance.agent, skills: undefined }),
    `https://${environment.domain}`,
  );
  const differences = manifestDifferences(
    manifest,
    await exportManifest(await configToken(), appId),
  );
  if (differences.length > 0) {
    throw new Error(
      `Slack app ${appId} does not match the generated ${environmentName} manifest:\n  ${differences.join("\n  ")}`,
    );
  }
  await writeLock(
    directory,
    withLockEnvironment(lock, environmentName, {
      d1: { id: d1Id, name: environment.d1.name },
      domain: environment.domain,
      slack: { appId, manifestSha256: manifestSha256(manifest) },
      worker: environment.worker,
    }),
  );
  return `Adopted ${environmentName} in ${path.join(directory, lockFileName)}`;
};
