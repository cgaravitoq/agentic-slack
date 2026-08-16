import type { SlackCoreBindings } from "@agentic-slack/core";

declare global {
  namespace Cloudflare {
    interface Env extends SlackCoreBindings {
      SLACK_SIGNING_SECRET: string;
      SLACK_BOT_TOKEN: string;
      SLACK_TEAM_ID: string;
      SLACK_APP_ID: string;
    }
  }
}
