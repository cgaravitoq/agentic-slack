import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import * as v from "valibot";

const parameters = v.array(v.union([v.string(), v.number(), v.null()]));
const isDatabase = (candidate: { prepare: unknown }): candidate is D1Database =>
  typeof candidate.prepare === "function";

export const database = async (): Promise<D1Database> => {
  const sqlite = new Database(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  const files = await readdir(directory);
  const sources = await Promise.all(
    files
      .filter((name) => name.endsWith(".sql"))
      .toSorted()
      .map((file) => Bun.file(new URL(file, directory)).text()),
  );
  for (const source of sources) {
    sqlite.run(source);
  }
  const db = {
    async batch(
      statements: { run: () => Promise<{ meta: { changes: number } }> }[],
    ) {
      sqlite.run("BEGIN");
      try {
        const results = await Promise.all(
          statements.map((statement) => statement.run()),
        );
        sqlite.run("COMMIT");
        return results;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      const statement = sqlite.query(sql);
      let values: v.InferOutput<typeof parameters> = [];
      return {
        all() {
          return Promise.resolve({ results: statement.all(...values) });
        },
        bind(...input: unknown[]) {
          values = v.parse(parameters, input);
          return this;
        },
        run() {
          return Promise.resolve({
            meta: { changes: statement.run(...values).changes },
          });
        },
      };
    },
  };
  if (!isDatabase(db)) {
    throw new Error("Invalid test database");
  }
  return db;
};
