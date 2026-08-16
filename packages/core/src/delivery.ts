import { defineTool } from "@flue/runtime/tool";
import * as v from "valibot";
import { CORE_REPLY_TOOL_NAME } from "./config.ts";

const BROADCAST_RE = /<!(?:channel|here|everyone)(?:\|[^>]*)?>/giu;
const SUBTEAM_RE = /<!subteam\^[^>]+>/giu;
const CONTROL_OPENER_RE = /<(?=[@#!])/gu;
const SLACK_TOKEN_RE = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+/gu;
const SECRET_ASSIGNMENT_RE =
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SIGNING_SECRET)[A-Z0-9_]*\s*[:=]\s*["']?[^,\s"']+/giu;

export const MAX_SLACK_MESSAGE_LENGTH = 3900;

export interface SlackDestination {
  channelId: string;
  threadTs: string;
}

export const extractAssistantText = (
  content?: readonly { type: string; text?: string }[],
): string => {
  if (!content) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0,
    )
    .map((block) => block.text)
    .join("\n");
};

export const SLACK_DELIVERY_FALLBACK =
  "I finished the turn but could not post a Slack reply. Please try again.";

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const sanitizeReply = (
  text: string,
  maxLength = MAX_SLACK_MESSAGE_LENGTH,
): string => {
  let safe = text
    .replace(BROADCAST_RE, "")
    .replace(SUBTEAM_RE, "")
    .replace(CONTROL_OPENER_RE, "&lt;")
    .replace(SLACK_TOKEN_RE, "[secret]")
    .replace(SECRET_ASSIGNMENT_RE, "[internal configuration]")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  if (!safe) {
    safe = "I could not produce a safe reply for that content.";
  }
  if (safe.length > maxLength) {
    safe = `${safe.slice(0, maxLength - 20).trimEnd()}\n\n(truncated)`;
  }
  return safe;
};

export const createReplyTool = (
  destination: SlackDestination,
  token: string,
  fetcher: Fetcher = fetch,
) => {
  let delivery: Promise<void> | undefined;
  return defineTool({
    description:
      "Post the final reply to the Slack conversation bound by trusted code. Call exactly once.",
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    name: CORE_REPLY_TOOL_NAME,
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
            body: JSON.stringify({
              channel: destination.channelId,
              text: sanitizeReply(data.text),
              thread_ts: destination.threadTs,
              unfurl_links: false,
              unfurl_media: false,
            }),
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json; charset=utf-8",
            },
            method: "POST",
          },
        );
        const result = v.parse(
          v.object({
            error: v.optional(v.string()),
            ok: v.optional(v.boolean()),
          }),
          await response.json(),
        );
        if (result.ok !== true) {
          throw new Error(
            `Slack chat.postMessage failed: ${result.error ?? response.status}`,
          );
        }
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
};
