import * as v from "valibot";
import { runWrangler, wranglerJson } from "./wrangler.ts";

const text = v.pipe(v.string(), v.minLength(1, "Expected a non-empty string"));

const d1Databases = v.array(v.object({ name: text, uuid: text }));

export interface Database {
  id: string;
  name: string;
}

const listDatabases = async (
  directory: string,
): Promise<readonly v.InferOutput<typeof d1Databases>[number][]> =>
  await wranglerJson(d1Databases, ["d1", "list", "--json"], {
    cwd: directory,
  });

export const verifyDatabase = async (
  database: Database,
  directory: string,
): Promise<void> => {
  const databases = await listDatabases(directory);
  const found = databases.find((candidate) => candidate.uuid === database.id);
  if (found === undefined) {
    throw new Error(
      `Cloudflare has no D1 database ${database.id} in this account: check the id or run wrangler d1 list`,
    );
  }
  if (found.name !== database.name) {
    throw new Error(
      `D1 database ${database.id} is named ${found.name}, but agent.yaml names it ${database.name}`,
    );
  }
};
