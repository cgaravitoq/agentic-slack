import type { ResolvedAgentConfig } from "./config.ts";

export function generateSlackManifest(
  config: ResolvedAgentConfig,
  deployedUrl: string,
): string {
  const origin = new URL(deployedUrl).origin;
  return JSON.stringify(
    {
      display_information: {
        name: config.name,
        description: config.description,
      },
      features: {
        bot_user: { display_name: config.name, always_online: true },
        agent_view: { agent_description: config.description },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "assistant:write",
            "chat:write",
            "im:history",
            "reactions:write",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          request_url: `${origin}/channels/slack/events`,
          bot_events: ["app_mention", "message.im"],
        },
        interactivity: { is_enabled: false },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
