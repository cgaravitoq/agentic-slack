#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { version } from "../package.json";

const help = `Usage: agentic-slack <command>

Commands:
  build --dir <dir> --env <env>  Build an instance's Worker

Options:
  --help     Show this help
  --version  Show the package version`;

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
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
  if (
    positionals.length !== 1 ||
    positionals[0] !== "build" ||
    values.dir === undefined ||
    values.dir === "" ||
    values.env === undefined ||
    !/^[a-zA-Z0-9_-]+$/u.test(values.env)
  ) {
    throw new Error(help);
  }

  const directory = path.resolve(values.dir);
  const output = path.join(directory, ".agentic-slack", values.env);
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
        AGENT_CONFIG: path.join(directory, "agent.config.ts"),
        CLOUDFLARE_ENV: values.env,
        WORKER_CONFIG: path.join(directory, "wrangler.jsonc"),
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

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
