import * as v from "valibot";
import { readSecret } from "./terminal.ts";

const text = v.pipe(v.string(), v.minLength(1, "Expected a non-empty string"));

const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_BASE_MS = 1000;

const slackResponseSchema = v.object({
  app_id: v.optional(text),
  credentials: v.optional(v.object({ signing_secret: v.optional(text) })),
  error: v.optional(v.string()),
  ok: v.optional(v.boolean()),
});

type SlackResponse = v.InferOutput<typeof slackResponseSchema>;

const retryDelayMs = (response: Response, attempt: number): number => {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : RATE_LIMIT_BASE_MS * 2 ** (attempt - 1);
};

const callSlack = async (
  method: string,
  token: string,
  fields: Record<string, string>,
): Promise<SlackResponse> => {
  for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const response = await fetch(`https://slack.com/api/${method}`, {
      body: new URLSearchParams(fields).toString(),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    // oxlint-disable-next-line no-await-in-loop
    const payload = v.parse(slackResponseSchema, await response.json());
    if (payload.ok === true) {
      return payload;
    }
    if (
      (payload.error === "ratelimited" || response.status === 429) &&
      attempt < RATE_LIMIT_ATTEMPTS
    ) {
      const delay = retryDelayMs(response, attempt);
      console.log(`Slack is rate limiting ${method}: retrying in ${delay}ms`);
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(delay);
      continue;
    }
    throw new Error(
      `Slack refused ${method}: ${payload.error ?? `HTTP ${response.status}`}`,
    );
  }
  throw new Error(`Slack kept rate limiting ${method}`);
};

export const configToken = async (): Promise<string> => {
  const fromEnvironment = process.env.SLACK_CONFIG_TOKEN;
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return fromEnvironment;
  }
  const answer = await readSecret("Slack configuration token: ");
  if (answer === "") {
    throw new Error(
      "Slack needs an app configuration token: set SLACK_CONFIG_TOKEN or answer the prompt",
    );
  }
  return answer;
};

export const createSlackApp = async (
  token: string,
  manifest: string,
): Promise<{ appId: string; signingSecret: string }> => {
  const response = await callSlack("apps.manifest.create", token, { manifest });
  const { app_id: appId, credentials } = response;
  if (appId === undefined || credentials?.signing_secret === undefined) {
    throw new Error(
      "Slack created the app without answering its id and signing secret",
    );
  }
  return { appId, signingSecret: credentials.signing_secret };
};

export const updateSlackApp = async (
  token: string,
  appId: string,
  manifest: string,
): Promise<void> => {
  await callSlack("apps.manifest.update", token, {
    app_id: appId,
    manifest,
  });
};

export const deleteSlackApp = async (
  token: string,
  appId: string,
): Promise<void> => {
  await callSlack("apps.manifest.delete", token, { app_id: appId });
};
