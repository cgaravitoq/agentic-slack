#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { adopt } from "../packages/core/src/adopt.ts";
import { readInstance, scaffoldFiles } from "../packages/core/src/instance.ts";
import { readLock } from "../packages/core/src/lock.ts";
import {
  buildEnvironment,
  down,
  prepareEnvironment,
  up,
} from "../packages/core/src/provision.ts";
import { version } from "../package.json";

const help = `Usage: agentic-slack <command>

Commands:
  init <dir>                     Scaffold an instance from a template
  build --dir <dir> --env <env>  Build an instance's Worker
  up --dir <dir> --env <env>     Provision an environment and deploy it
  down --dir <dir> --env <env>   Delete an environment's locked resources
  adopt --dir <dir> --env <env>  Adopt an existing D1, Worker and Slack app

Options:
  --d1-id <id>    D1 database id to adopt
  --app-id <id>   Slack app id to adopt
  --rotate <name> Set a Worker secret again even when it already exists
  --help          Show this help
  --version       Show the package version`;

const migrationsDirectory = path.resolve(
  import.meta.dirname,
  "../apps/slack-agent/migrations",
);

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const appendGitignore = async (
  target: string,
  contents: string,
): Promise<void> => {
  const existing = (await Bun.file(target).exists())
    ? await Bun.file(target).text()
    : "";
  const lines = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = contents
    .split("\n")
    .filter((line) => line !== "" && !lines.has(line));
  if (missing.length === 0) {
    return;
  }
  await Bun.write(
    target,
    `${existing}${existing !== "" && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
};

const init = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    scaffoldFiles(version).map(async (file) => {
      const target = path.join(directory, file.name);
      if (file.append) {
        await appendGitignore(target, file.contents);
        return;
      }
      if (await Bun.file(target).exists()) {
        throw new Error(`${target} already exists`);
      }
      await Bun.write(target, file.contents);
    }),
  );
  console.log(`Initialized ${directory}
Edit its agent.yaml, then build an environment with: agentic-slack build --dir ${directory} --env staging`);
};

interface EnvironmentArguments {
  directory: string;
  environment: string;
}

const environmentArguments = (
  command: string,
  positionals: readonly string[],
  values: { dir?: string; env?: string },
): EnvironmentArguments | undefined => {
  if (positionals[0] !== command || positionals.length !== 1) {
    return undefined;
  }
  const directory = nonEmpty(values.dir);
  const environment = nonEmpty(values.env);
  if (
    directory === undefined ||
    environment === undefined ||
    !/^[a-zA-Z0-9_-]+$/u.test(environment)
  ) {
    return undefined;
  }
  return { directory: path.resolve(directory), environment };
};

const build = async ({
  directory,
  environment,
}: EnvironmentArguments): Promise<void> => {
  const instance = await readInstance(directory);
  const lock = await readLock(directory);
  const preparation = await prepareEnvironment({
    directory,
    environment,
    instance,
    lock,
    migrationsDirectory,
  });
  console.log(await buildEnvironment(preparation));
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      "app-id": { type: "string" },
      "d1-id": { type: "string" },
      dir: { type: "string" },
      env: { type: "string" },
      help: { type: "boolean" },
      rotate: { multiple: true, type: "string" },
      version: { type: "boolean" },
    },
  });
  if (values.help === true) {
    console.log(help);
    return;
  }
  if (values.version === true) {
    console.log(version);
    return;
  }
  const [command, argument] = positionals;
  if (
    command === "init" &&
    positionals.length === 2 &&
    argument !== undefined &&
    argument !== ""
  ) {
    await init(path.resolve(argument));
    return;
  }
  const named = environmentArguments(command ?? "", positionals, values);
  if (named !== undefined) {
    if (command === "build") {
      await build(named);
      return;
    }
    if (command === "up") {
      console.log(
        await up({
          ...named,
          migrationsDirectory,
          rotate: values.rotate ?? [],
        }),
      );
      return;
    }
    if (command === "down") {
      console.log(await down(named));
      return;
    }
    if (command === "adopt") {
      console.log(
        await adopt({
          ...named,
          appId: nonEmpty(values["app-id"]),
          d1Id: nonEmpty(values["d1-id"]),
        }),
      );
      return;
    }
  }
  throw new Error(help);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
