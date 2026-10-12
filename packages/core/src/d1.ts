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

export const findOrCreateDatabase = async (
  name: string,
  directory: string,
): Promise<Database> => {
  const listed = await listDatabases(directory);
  const existing = listed.find((candidate) => candidate.name === name);
  if (existing !== undefined) {
    return { id: existing.uuid, name: existing.name };
  }
  await runWrangler(["d1", "create", name], { cwd: directory });
  const created = await listDatabases(directory);
  const database = created.find((candidate) => candidate.name === name);
  if (database === undefined) {
    throw new Error(
      `wrangler d1 create did not create a database named ${name}: run wrangler d1 list`,
    );
  }
  return { id: database.uuid, name: database.name };
};
