import type { ResolvedAgentConfig } from "./config.ts";

export const generateSlackManifest = <RuntimeContext>(
  config: ResolvedAgentConfig<RuntimeContext>,
  deployedUrl: string,
): string => {
  const { origin } = new URL(deployedUrl);
  return JSON.stringify(
    {
      display_information: {
        description: config.description,
        name: config.name,
      },
      features: {
        agent_view: { agent_description: config.description },
        app_home: {
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { always_online: true, display_name: config.name },
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
          bot_events: ["app_mention", "assistant_thread_started", "message.im"],
          request_url: `${origin}/channels/slack/events`,
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
};
