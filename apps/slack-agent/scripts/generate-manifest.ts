import { generateSlackManifest } from "@agentic-slack/core";
import config from "../agent.config.ts";

const deployedUrl = process.argv[2];
if (!deployedUrl) throw new Error("Usage: bun run manifest <deployed-url>");
process.stdout.write(`${generateSlackManifest(config, deployedUrl)}\n`);
