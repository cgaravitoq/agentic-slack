import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { defineAgentConfig } from "./config.ts";
import { findOrCreateDatabase, verifyDatabase } from "./d1.ts";
import {
  generateAgentConfigModule,
  generateWranglerConfig,
  readInstance,
} from "./instance.ts";
import type { AgentInstance } from "./instance.ts";
import {
  lockFileName,
  manifestSha256,
  readLock,
  withLockEnvironment,
  withoutLockEnvironment,
  writeLock,
} from "./lock.ts";
import type { InstanceLock, LockEnvironment } from "./lock.ts";
import { generateSlackManifest } from "./manifest.ts";
import {
  configToken,
  createSlackApp,
  deleteSlackApp,
  updateSlackApp,
} from "./slack-app.ts";
import { readAnswer, readSecret } from "./terminal.ts";
import { runWrangler, wranglerJson } from "./wrangler.ts";

const text = v.pipe(v.string(), v.minLength(1, "Expected a non-empty string"));

const BOT_TOKEN_SECRET = "SLACK_BOT_TOKEN";
const SIGNING_SECRET = "SLACK_SIGNING_SECRET";

// The signing secret comes from the app the Slack phase creates and the bot
// token only exists once the operator installs it, so the general secrets loop
// cannot read either before that phase has run.
const slackSuppliedSecrets = new Set([BOT_TOKEN_SECRET, SIGNING_SECRET]);

const installUrl = (appId: string): string =>
  `https://api.slack.com/apps/${appId}/install-on-team`;

const HEALTH_ATTEMPTS = 5;
const HEALTH_DELAY_MS = 2000;

export interface PrepareOptions {
  directory: string;
  environment: string;
  instance: AgentInstance;
  lock: InstanceLock;
  migrationsDirectory: string;
}

export interface EnvironmentPreparation {
  agentConfig: string;
  directory: string;
  environment: string;
  output: string;
  worker: string;
  wranglerConfig: string;
}

export interface UpOptions {
  directory: string;
  environment: string;
  migrationsDirectory: string;
  rotate?: readonly string[];
}

export interface DownOptions {
  directory: string;
  environment: string;
}

const generatedDirectory = (directory: string): string =>
  path.join(directory, ".agentic-slack");

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

export const prepareEnvironment = async (
  options: PrepareOptions,
): Promise<EnvironmentPreparation> => {
  const { directory, environment, instance, lock, migrationsDirectory } =
    options;
  const named = instance.environments[environment];
  if (named === undefined) {
    throw new Error(`agent.yaml has no environment ${environment}`);
  }
  const generated = generatedDirectory(directory);
  const agentConfig = path.join(generated, "agent.config.ts");
  await mkdir(generated, { recursive: true });
  await Bun.write(
    agentConfig,
    generateAgentConfigModule(
      instance,
      await skillFiles(directory, instance.agent.skills ?? []),
      generated,
    ),
  );
  const wranglerConfig = path.join(generated, "wrangler.jsonc");
  await Bun.write(
    wranglerConfig,
    generateWranglerConfig(
      instance,
      environment,
      migrationsDirectory,
      generated,
      lock,
    ),
  );
  return {
    agentConfig,
    directory,
    environment,
    output: path.join(generated, environment),
    worker: named.worker,
    wranglerConfig,
  };
};

export const buildEnvironment = async (
  preparation: EnvironmentPreparation,
): Promise<string> => {
  const { directory, environment, agentConfig, output, wranglerConfig } =
    preparation;
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
      path.resolve(
        import.meta.dirname,
        "../../../apps/slack-agent/vite.config.ts",
      ),
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        AGENT_CONFIG: agentConfig,
        CLOUDFLARE_ENV: environment,
        WORKER_CONFIG: wranglerConfig,
        WORKER_OUT_DIR: output,
      },
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(
      `vite build of ${preparation.worker} failed with exit code ${exitCode}`,
    );
  }
  const configs = await Array.fromAsync(
    new Bun.Glob("*/wrangler.json").scan({ absolute: true, cwd: output }),
  );
  if (configs.length !== 1) {
    throw new Error(`Expected one generated wrangler.json in ${output}`);
  }
  return configs[0];
};

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const databaseFor = async (
  directory: string,
  environmentName: string,
  name: string,
  declaredId: string | undefined,
  lock: InstanceLock,
): Promise<LockEnvironment["d1"]> => {
  const locked = lock.environments[environmentName]?.d1;
  if (locked !== undefined) {
    return locked;
  }
  const declared = present(declaredId);
  if (declared !== undefined) {
    await verifyDatabase({ id: declared, name }, directory);
    return { id: declared, name };
  }
  const database = await findOrCreateDatabase(name, directory);
  return { id: database.id, name: database.name };
};

const secretList = v.array(v.object({ name: text }));

const secretValue = async (name: string): Promise<string> => {
  const fromEnvironment = process.env[name];
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return fromEnvironment;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `${name} is not a Worker secret and the environment does not set it: export ${name} or run this command from a terminal to be prompted`,
    );
  }
  const answer = await readSecret(`${name}: `);
  if (answer === "") {
    throw new Error(`${name} needs a non-empty value`);
  }
  return answer;
};

interface SecretReport {
  kept: readonly string[];
  set: readonly string[];
}

const putSecret = async (
  directory: string,
  worker: string,
  name: string,
  value: string,
): Promise<void> => {
  await runWrangler(["secret", "put", name, "--name", worker], {
    cwd: directory,
    input: `${value}\n`,
  });
};

const workerSecretNames = async (
  directory: string,
  worker: string,
): Promise<ReadonlySet<string>> => {
  const listed = await wranglerJson(
    secretList,
    ["secret", "list", "--name", worker, "--format", "json"],
    { cwd: directory },
  );
  return new Set(listed.map((secret) => secret.name));
};

const ensureSecrets = async (
  directory: string,
  worker: string,
  declared: readonly string[],
  rotate: readonly string[],
): Promise<SecretReport> => {
  const existing = await workerSecretNames(directory, worker);
  const kept: string[] = [];
  const set: string[] = [];
  for (const name of declared) {
    if (existing.has(name) && !rotate.includes(name)) {
      kept.push(name);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    await putSecret(directory, worker, name, await secretValue(name));
    set.push(name);
  }
  return { kept, set };
};

const healthSchema = v.object({
  missing: v.optional(v.array(v.string())),
  status: v.string(),
});

const readReadiness = async (
  url: string,
): Promise<v.InferOutput<typeof healthSchema> | undefined> => {
  try {
    const response = await fetch(url);
    const parsed = v.safeParse(healthSchema, await response.json());
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
};

const waitForHealth = async (domain: string): Promise<void> => {
  const url = `https://${domain}/health`;
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const health = await readReadiness(url);
    if (health !== undefined) {
      if (health.status === "ready") {
        console.log(`${url} is ready`);
        return;
      }
      throw new Error(
        `${url} is not ready: missing ${health.missing?.join(", ") ?? "bindings"}`,
      );
    }
    if (attempt < HEALTH_ATTEMPTS) {
      // oxlint-disable-next-line no-await-in-loop
      await Bun.sleep(HEALTH_DELAY_MS);
    }
  }
  throw new Error(
    `${url} did not answer /health: check that ${domain} resolves to the deployed Worker`,
  );
};

interface SlackAppOptions {
  directory: string;
  domain: string;
  entry: LockEnvironment;
  environment: string;
  instance: AgentInstance;
  lock: InstanceLock;
  migrationsDirectory: string;
  rotate: readonly string[];
  worker: string;
}

const ensureSlackApp = async (options: SlackAppOptions): Promise<void> => {
  const {
    directory,
    domain,
    entry,
    environment: environmentName,
    instance,
    lock,
    migrationsDirectory,
    rotate,
    worker,
  } = options;
  const manifest = generateSlackManifest(
    defineAgentConfig({ ...instance.agent, skills: undefined }),
    `https://${domain}`,
  );
  const sha256 = manifestSha256(manifest);
  const locked = entry.slack;

  const applyManifest = async (): Promise<string> => {
    if (locked === undefined) {
      const created = await createSlackApp(await configToken(), manifest);
      await putSecret(directory, worker, SIGNING_SECRET, created.signingSecret);
      console.log(`Set ${SIGNING_SECRET} from Slack app ${created.appId}`);
      const withApp = withLockEnvironment(lock, environmentName, {
        ...entry,
        slack: { appId: created.appId, manifestSha256: sha256 },
      });
      await writeLock(directory, withApp);
      console.log(`Created Slack app ${created.appId}`);
      // The deployed Worker carries SLACK_APP_ID, which did not exist before.
      const preparation = await prepareEnvironment({
        directory,
        environment: environmentName,
        instance,
        lock: withApp,
        migrationsDirectory,
      });
      const configPath = await buildEnvironment(preparation);
      await runWrangler(["deploy", "--config", configPath], { cwd: directory });
      console.log(`Deployed ${worker} with SLACK_APP_ID ${created.appId}`);
      return created.appId;
    }
    if (locked.manifestSha256 === sha256) {
      console.log(`Slack app ${locked.appId} matches the generated manifest`);
      return locked.appId;
    }
    // An update replaces the whole manifest and returns no credentials, so a
    // signing secret only ever comes from creating an app.
    await updateSlackApp(await configToken(), locked.appId, manifest);
    await writeLock(
      directory,
      withLockEnvironment(lock, environmentName, {
        ...entry,
        slack: { appId: locked.appId, manifestSha256: sha256 },
      }),
    );
    console.log(`Updated Slack app ${locked.appId}`);
    return locked.appId;
  };
  const appId = await applyManifest();

  const existing = await workerSecretNames(directory, worker);
  if (rotate.includes(BOT_TOKEN_SECRET) || !existing.has(BOT_TOKEN_SECRET)) {
    console.log(`Install the app for its bot token: ${installUrl(appId)}`);
    await putSecret(
      directory,
      worker,
      BOT_TOKEN_SECRET,
      await secretValue(BOT_TOKEN_SECRET),
    );
    console.log(`Set ${BOT_TOKEN_SECRET}`);
  }
};

export const up = async (options: UpOptions): Promise<string> => {
  const {
    directory,
    environment: environmentName,
    migrationsDirectory,
    rotate = [],
  } = options;
  const instance = await readInstance(directory);
  const named = instance.environments[environmentName];
  if (named === undefined) {
    throw new Error(`agent.yaml has no environment ${environmentName}`);
  }
  const declared = new Set(instance.secrets);
  const unknown = rotate.filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `--rotate names secrets agent.yaml does not declare: ${unknown.join(", ")}`,
    );
  }

  const lock = await readLock(directory);
  const previous = lock.environments[environmentName];
  const d1 = await databaseFor(
    directory,
    environmentName,
    named.d1.name,
    named.d1.id,
    lock,
  );
  // The D1 exists from this point, so it is recorded before the deploy that may
  // fail: `down` and a rerun both have to find it instead of creating a second
  // database.
  const databaseLock = withLockEnvironment(lock, environmentName, {
    d1,
    slack: previous?.slack,
  });
  await writeLock(directory, databaseLock);
  console.log(`D1 ${d1.name} (${d1.id})`);

  const preparation = await prepareEnvironment({
    directory,
    environment: environmentName,
    instance,
    lock: databaseLock,
    migrationsDirectory,
  });
  await runWrangler(
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      preparation.wranglerConfig,
      "--env",
      environmentName,
      "--remote",
    ],
    { cwd: directory },
  );
  console.log(`Applied the D1 migrations to ${d1.name}`);

  const configPath = await buildEnvironment(preparation);
  console.log(`Built ${named.worker}`);

  await runWrangler(["deploy", "--config", configPath], { cwd: directory });
  console.log(`Deployed ${named.worker} to https://${named.domain}`);

  const entry: LockEnvironment = {
    d1,
    domain: named.domain,
    slack: previous?.slack,
    worker: named.worker,
  };
  const deployedLock = withLockEnvironment(
    databaseLock,
    environmentName,
    entry,
  );
  await writeLock(directory, deployedLock);

  const secrets = await ensureSecrets(
    directory,
    named.worker,
    instance.secrets.filter((name) => !slackSuppliedSecrets.has(name)),
    rotate,
  );
  const described = [
    ...(secrets.set.length === 0 ? [] : [`set ${secrets.set.join(", ")}`]),
    ...(secrets.kept.length === 0 ? [] : [`kept ${secrets.kept.join(", ")}`]),
  ];
  console.log(
    `Worker secrets: ${described.length === 0 ? "none declared" : described.join("; ")}`,
  );

  await ensureSlackApp({
    directory,
    domain: named.domain,
    entry,
    environment: environmentName,
    instance,
    lock: deployedLock,
    migrationsDirectory,
    rotate,
    worker: named.worker,
  });
  await waitForHealth(named.domain);
  return `Provisioned ${environmentName}: https://${named.domain}`;
};

const workerExists = async (
  worker: string,
  directory: string,
): Promise<boolean> => {
  try {
    await runWrangler(["deployments", "list", "--name", worker, "--json"], {
      cwd: directory,
    });
    return true;
  } catch {
    return false;
  }
};

export const down = async (options: DownOptions): Promise<string> => {
  const { directory, environment: environmentName } = options;
  const instance = await readInstance(directory);
  const named = instance.environments[environmentName];
  if (named === undefined) {
    throw new Error(`agent.yaml has no environment ${environmentName}`);
  }
  const lock = await readLock(directory);
  const entry = lock.environments[environmentName];
  if (entry === undefined) {
    throw new Error(
      `${lockFileName} has no ${environmentName} environment: nothing to delete`,
    );
  }
  const expected = `${instance.agent.name}/${environmentName}`;
  console.log(`Deleting the ${environmentName} environment of ${expected}:`);
  console.log(`  D1 ${entry.d1.name} (${entry.d1.id})`);
  if (entry.worker !== undefined) {
    console.log(`  Worker ${entry.worker}`);
  }
  if (entry.domain !== undefined) {
    console.log(`  Custom domain https://${entry.domain}`);
  }
  if (entry.slack !== undefined) {
    console.log(`  Slack app ${entry.slack.appId}`);
  }
  const answer = await readAnswer(`Type ${expected} to delete: `);
  if (answer !== expected) {
    throw new Error(
      `Nothing deleted: expected the exact text ${expected} and read ${answer === "" ? "an empty line" : answer}`,
    );
  }
  if (entry.worker !== undefined) {
    if (await workerExists(entry.worker, directory)) {
      await runWrangler(["delete", entry.worker, "--force"], {
        cwd: directory,
      });
      console.log(`Deleted Worker ${entry.worker}`);
    } else {
      console.log(`Worker ${entry.worker} is already gone`);
    }
  }
  if (entry.slack !== undefined) {
    await deleteSlackApp(await configToken(), entry.slack.appId);
    console.log(`Deleted Slack app ${entry.slack.appId}`);
  }
  await runWrangler(["d1", "delete", entry.d1.name, "--skip-confirmation"], {
    cwd: directory,
  });
  await writeLock(directory, withoutLockEnvironment(lock, environmentName));
  return `Deleted the ${environmentName} environment and removed it from ${lockFileName}`;
};
