import { defineTool } from "@flue/runtime";
import type { ToolDefinition } from "@flue/runtime";
import * as v from "valibot";
import { callSlack, slackEnvelope } from "./read.ts";
import type { SlackCaller } from "./read.ts";

const PAGE_LIMIT = 200;

const nextCursor = v.optional(
  v.object({ next_cursor: v.optional(v.string()) }),
);

const membersPageSchema = v.object({
  ...slackEnvelope,
  members: v.optional(v.array(v.string()), []),
  response_metadata: nextCursor,
});

const directoryUserSchema = v.object({
  deleted: v.optional(v.boolean()),
  id: v.string(),
  name: v.optional(v.string()),
  profile: v.optional(
    v.object({
      display_name: v.optional(v.string()),
      real_name: v.optional(v.string()),
    }),
  ),
  real_name: v.optional(v.string()),
});

type DirectoryUser = v.InferOutput<typeof directoryUserSchema>;

const usersPageSchema = v.object({
  ...slackEnvelope,
  members: v.optional(v.array(directoryUserSchema), []),
  response_metadata: nextCursor,
});

interface MembersPage<TMember> {
  readonly error?: string;
  readonly members: TMember[];
  readonly ok: boolean;
  readonly response_metadata?: { readonly next_cursor?: string };
}

const allMembers = async <TMember>(
  caller: SlackCaller,
  method: string,
  params: Record<string, string>,
  schema: v.GenericSchema<unknown, MembersPage<TMember>>,
): Promise<TMember[]> => {
  const members: TMember[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop
    const page = await callSlack(
      caller,
      method,
      { ...params, cursor, limit: String(PAGE_LIMIT) },
      schema,
    );
    members.push(...page.members);
    cursor = page.response_metadata?.next_cursor;
  } while (cursor !== undefined && cursor !== "");
  return members;
};

export interface SlackMember {
  readonly name: string;
  readonly userId: string;
}

const namesOf = (user: DirectoryUser): string[] =>
  [
    user.profile?.display_name,
    user.real_name,
    user.profile?.real_name,
    user.name,
  ].filter((name): name is string => name !== undefined && name.trim() !== "");

const folded = (text: string): string =>
  text.normalize("NFD").replaceAll(/\p{M}/gu, "").trim().toLowerCase();

export const loadChannelMembers = async (
  caller: SlackCaller,
  channelId: string,
): Promise<DirectoryUser[]> => {
  const memberIds = new Set(
    await allMembers(
      caller,
      "conversations.members",
      { channel: channelId },
      membersPageSchema,
    ),
  );
  const users = await allMembers(caller, "users.list", {}, usersPageSchema);
  return users.filter(
    (user) => memberIds.has(user.id) && user.deleted !== true,
  );
};

// A person is asked for the way people say them: an ID, a mention someone
// pasted, a display or real name, or one word of it. The strictest form that
// matches anyone wins, so "Ana" never turns ambiguous because "Ana María" also
// exists once an exact "Ana" does.
export const matchMember = (
  users: readonly DirectoryUser[],
  query: string,
): SlackMember[] => {
  const wanted = folded(
    query
      .trim()
      .replace(/^<@(?<id>[^|>]+)(?:\|[^>]*)?>$/u, "$<id>")
      .replace(/^@/u, ""),
  );
  const tiers = [
    (user: DirectoryUser) => folded(user.id) === wanted,
    (user: DirectoryUser) =>
      namesOf(user).some((name) => folded(name) === wanted),
    (user: DirectoryUser) =>
      namesOf(user).some((name) => ` ${folded(name)} `.includes(` ${wanted} `)),
  ];
  for (const matches of tiers) {
    const found = users.filter(matches);
    if (found.length > 0) {
      return found.map((user) => ({
        name: namesOf(user)[0]?.trim() ?? user.id,
        userId: user.id,
      }));
    }
  }
  return [];
};

const mentionInput = v.object({ member: v.pipe(v.string(), v.nonEmpty()) });

const mentionOutput = v.object({ tagged: v.string(), userId: v.string() });

export const createSlackMentionTool = (
  channelId: string,
  options: Pick<SlackCaller, "token"> & Partial<Pick<SlackCaller, "fetcher">>,
  tag: (userId: string) => void,
): ToolDefinition<
  typeof mentionInput,
  typeof mentionOutput,
  boolean,
  boolean
> =>
  defineTool({
    description:
      "Tag a member of this conversation's channel so Slack notifies them. Use it whenever you are asked to mention, tag, ping or loop someone in. Pass their display name, real name, one word of it, or their user ID. Trusted code adds the tag under your reply, so do not write it into your text, and call once per person. Only members of this channel can be tagged.",
    input: mentionInput,
    name: "mention_member",
    output: mentionOutput,
    async run({ data, signal }) {
      const caller: SlackCaller = {
        fetcher: options.fetcher ?? fetch,
        signal,
        token: options.token,
      };
      const matches = matchMember(
        await loadChannelMembers(caller, channelId),
        data.member,
      );
      const [match] = matches;
      if (match === undefined) {
        throw new Error(`No member of this channel matches ${data.member}`);
      }
      if (matches.length > 1) {
        const named = matches
          .map((candidate) => `${candidate.name} (${candidate.userId})`)
          .join(", ");
        throw new Error(
          `Several members of this channel match ${data.member}: ${named}. Call again with the user ID of the one meant.`,
        );
      }
      tag(match.userId);
      return { output: { tagged: match.name, userId: match.userId } };
    },
  });
