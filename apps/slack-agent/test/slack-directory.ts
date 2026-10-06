import * as v from "valibot";

export interface DirectoryUser {
  readonly deleted?: boolean;
  readonly id: string;
  readonly name?: string;
  readonly profile?: {
    readonly display_name?: string;
    readonly real_name?: string;
  };
  readonly real_name?: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const PAGE_SIZE = 2;

const page = (items: readonly unknown[], cursor: string | null): Response => {
  const offset = Number(cursor ?? "0");
  const next =
    offset + PAGE_SIZE < items.length ? String(offset + PAGE_SIZE) : "";
  return Response.json({
    members: items.slice(offset, offset + PAGE_SIZE),
    ok: true,
    response_metadata: { next_cursor: next },
  });
};

export const slackDirectory =
  (
    members: Readonly<Record<string, readonly string[]>>,
    users: readonly DirectoryUser[],
    delegate: Fetcher = () =>
      Promise.reject(new Error("Unexpected Slack call")),
  ): Fetcher =>
  (input, init) => {
    const url = v.parse(v.string(), input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    if (method !== "conversations.members" && method !== "users.list") {
      return delegate(input, init);
    }
    const body = v.parse(v.instance(URLSearchParams), init?.body);
    if (method === "users.list") {
      return Promise.resolve(page(users, body.get("cursor")));
    }
    const channel = members[body.get("channel") ?? ""];
    return Promise.resolve(
      channel === undefined
        ? Response.json({ error: "channel_not_found", ok: false })
        : page(channel, body.get("cursor")),
    );
  };

export const directoryUsers: readonly DirectoryUser[] = [
  {
    id: "U0JUAN",
    name: "juan.perez",
    profile: { display_name: "", real_name: "Juan Pérez" },
    real_name: "Juan Pérez",
  },
  {
    id: "U0ANA",
    name: "ana",
    profile: { display_name: "ana.r", real_name: "Ana" },
    real_name: "Ana",
  },
  { id: "U0ANAM", name: "anamaria", real_name: "Ana María López" },
  { id: "U0OUT", name: "juan.gomez", real_name: "Juan Gómez" },
  { deleted: true, id: "U0GONE", name: "pedro", real_name: "Pedro Ríos" },
  { id: "U0JUANR", name: "jruiz", real_name: "Juan Ruiz" },
];
