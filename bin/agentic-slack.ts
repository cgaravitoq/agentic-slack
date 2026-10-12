#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  generateAgentConfigModule,
  generateWranglerConfig,
  readInstance,
  scaffoldFiles,
} from "../packages/core/src/instance.ts";
import { readLock } from "../packages/core/src/lock.ts";
import { adopt } from "../packages/core/src/adopt.ts";
import { version } from "../package.json";

const help = `Usage: agentic-slack <command>

Commands:
  init <dir>                     Scaffold an instance from a template
  build --dir <dir> --env <env>  Build an instance's Worker
  adopt --dir <dir> --env <env>  Adopt an existing D1, Worker and Slack app

Options:
  --d1-id <id>   D1 database id to adopt
  --app-id <id>  Slack app id to adopt
  --help         Show this help
  --version      Show the package version`;

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

const skillFiles = async (
  directory: string,
  skills: readonly string[],
): Promise<readonly string[]> =>
  await Promise.all(
    skills.map(async (skill) => {
      const file = path.resolve(directory, skill, "SKILL.md");
      if (!(await Bun.file(file).exists())) {
        throw new Error(`agent.yaml: ${skill} has no SKILL.md`);
      }
      return file;
    }),
  );

const build = async (directory: string, environment: string): Promise<void> => {
  const instance = await readInstance(directory);
  if (instance.environments[environment] === undefined) {
    throw new Error(`agent.yaml has no environment ${environment}`);
  }
  const lock = await readLock(directory);
  const skills = await skillFiles(directory, instance.agent.skills ?? []);
  const generated = path.join(directory, ".agentic-slack");
  const agentConfig = path.join(generated, "agent.config.ts");
  await mkdir(generated, { recursive: true });
  await Bun.write(
    agentConfig,
    generateAgentConfigModule(instance, skills, generated),
  );
  await Bun.write(
    path.join(generated, "wrangler.jsonc"),
    generateWranglerConfig(instance, migrationsDirectory, generated, lock),
  );

  const output = path.join(generated, environment);
  // Vite leaves the output of a previous build of another Worker in place, and
  // the deploy step must see exactly the Worker just built.
  await rm(output, { force: true, recursive: true });
  const vite = path.join(
    path.dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
    "bin/vite.js",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      vite,
      "build",
      "--config",
      path.resolve(import.meta.dirname, "../apps/slack-agent/vite.config.ts"),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        AGENT_CONFIG: agentConfig,
        CLOUDFLARE_ENV: environment,
        WORKER_CONFIG: path.join(generated, "wrangler.jsonc"),
        WORKER_OUT_DIR: output,
      },
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  const configs = await Array.fromAsync(
    new Bun.Glob("*/wrangler.json").scan({ absolute: true, cwd: output }),
  );
  if (configs.length !== 1) {
    throw new Error(`Expected one generated wrangler.json in ${output}`);
  }
  console.log(configs[0]);
};

const adoptCommand = async (
  directory: string,
  environment: string,
  d1Id: string | undefined,
  appId: string | undefined,
): Promise<void> => {
  console.log(await adopt({ appId, d1Id, directory, environment }));
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
  if (
    command === "build" &&
    positionals.length === 1 &&
    values.dir !== undefined &&
    values.dir !== "" &&
    values.env !== undefined &&
    /^[a-zA-Z0-9_-]+$/u.test(values.env)
  ) {
    await build(path.resolve(values.dir), values.env);
    return;
  }
  if (
    command === "adopt" &&
    positionals.length === 1 &&
    values.dir !== undefined &&
    values.dir !== "" &&
    values.env !== undefined &&
    /^[a-zA-Z0-9_-]+$/u.test(values.env)
  ) {
    await adoptCommand(
      path.resolve(values.dir),
      values.env,
      nonEmpty(values["d1-id"]),
      nonEmpty(values["app-id"]),
    );
    return;
  }
  throw new Error(help);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
