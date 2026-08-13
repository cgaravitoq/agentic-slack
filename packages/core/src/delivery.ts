import { defineTool } from "@flue/runtime/tool";
import * as v from "valibot";
import { CORE_REPLY_TOOL_NAME } from "./config.ts";

const BROADCAST_RE = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/gi;
const SUBTEAM_RE = /<!subteam\^[^>]+>/gi;
const CONTROL_OPENER_RE = /<(?=[@#!])/g;
const SLACK_TOKEN_RE = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+/g;
const SECRET_ASSIGNMENT_RE =
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SIGNING_SECRET)[A-Z0-9_]*\s*[:=]\s*["']?[^,\s"']+/gi;

export const MAX_SLACK_MESSAGE_LENGTH = 3900;

export interface SlackDestination {
  channelId: string;
  threadTs: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function sanitizeReply(
  text: string,
  maxLength = MAX_SLACK_MESSAGE_LENGTH,
): string {
  let safe = text
    .replace(BROADCAST_RE, "")
    .replace(SUBTEAM_RE, "")
    .replace(CONTROL_OPENER_RE, "&lt;")
    .replace(SLACK_TOKEN_RE, "[secret]")
    .replace(SECRET_ASSIGNMENT_RE, "[internal configuration]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!safe) safe = "I could not produce a safe reply for that content.";
  if (safe.length > maxLength)
    safe = `${safe.slice(0, maxLength - 20).trimEnd()}\n\n(truncated)`;
  return safe;
}

export function createReplyTool(
  destination: SlackDestination,
  token: string,
  fetcher: Fetcher = fetch,
) {
  let delivery: Promise<void> | undefined;
  return defineTool({
    name: CORE_REPLY_TOOL_NAME,
    description:
      "Post the final reply to the Slack conversation bound by trusted code. Call exactly once.",
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    output: v.string(),
    async run({ data }) {
      if (delivery) {
        await delivery;
        return { output: "already posted" };
      }
      delivery = (async () => {
        const response = await fetcher(
          "https://slack.com/api/chat.postMessage",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              channel: destination.channelId,
              thread_ts: destination.threadTs,
              text: sanitizeReply(data.text),
              unfurl_links: false,
              unfurl_media: false,
            }),
          },
        );
        const result = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!result.ok)
          throw new Error(
            `Slack chat.postMessage failed: ${result.error ?? response.status}`,
          );
      })();
      try {
        await delivery;
      } catch (error) {
        delivery = undefined;
        throw error;
      }
      return { output: "posted", terminate: true };
    },
  });
}
