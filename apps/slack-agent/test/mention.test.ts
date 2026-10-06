import { describe, expect, test } from "bun:test";
import { createSlackMentionTool } from "@agentic-slack/core";
import { directoryUsers, slackDirectory } from "./slack-directory.ts";

const silentLog = { error: () => {}, info: () => {}, warn: () => {} };

const refusalOf = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the mention to be refused");
};

const mentionHarness = (members: readonly string[]) => {
  const tagged: string[] = [];
  const tool = createSlackMentionTool(
    "C1",
    {
      fetcher: slackDirectory({ C1: members }, directoryUsers),
      token: "xoxb-test",
    },
    (userId) => {
      tagged.push(userId);
    },
  );
  const mention = async (member: string) =>
    await tool.run({
      data: { member },
      log: silentLog,
      toolCallId: "mention-call",
    });
  return { mention, tagged };
};

describe("mention_member", () => {
  test("tags the one channel member a name, a word of it, an ID or a pasted mention names", async () => {
    const { mention, tagged } = mentionHarness([
      "U0JUAN",
      "U0ANA",
      "U0ANAM",
      "U0GONE",
    ]);
    const queries = [
      "Juan Pérez",
      "perez",
      "juan",
      "@ana.r",
      "<@U0ANA|ana>",
      "u0anam",
      "Maria",
    ];

    const results = [];
    for (const query of queries) {
      // oxlint-disable-next-line no-await-in-loop
      results.push(await mention(query));
    }

    expect(tagged).toEqual([
      "U0JUAN",
      "U0JUAN",
      "U0JUAN",
      "U0ANA",
      "U0ANA",
      "U0ANAM",
      "U0ANAM",
    ]);
    expect(results[0]).toEqual({
      output: { tagged: "Juan Pérez", userId: "U0JUAN" },
    });
    expect(results[3]).toEqual({
      output: { tagged: "ana.r", userId: "U0ANA" },
    });
  });

  test("refuses someone outside the channel, a deleted member, and a name several members answer to, even one that is whole for one of them", async () => {
    const { mention, tagged } = mentionHarness([
      "U0JUAN",
      "U0JUANR",
      "U0GONE",
      "U0ANA",
      "U0ANAM",
    ]);

    expect(await refusalOf(mention("Juan Gómez"))).toBe(
      "No member of this channel matches Juan Gómez",
    );
    expect(await refusalOf(mention("Pedro"))).toBe(
      "No member of this channel matches Pedro",
    );
    expect(await refusalOf(mention("juan"))).toBe(
      "Several members of this channel match juan: Juan Pérez (U0JUAN), Juan Ruiz (U0JUANR). Call again with the user ID of the one meant.",
    );
    expect(await refusalOf(mention("Ana"))).toBe(
      "Several members of this channel match Ana: ana.r (U0ANA), Ana María López (U0ANAM). Call again with the user ID of the one meant.",
    );
    expect(tagged).toEqual([]);
  });
});
