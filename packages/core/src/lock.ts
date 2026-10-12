import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";
import { issuePath } from "./instance.ts";

const text = v.pipe(v.string(), v.minLength(1, "Expected a non-empty string"));

export const lockFileName = "agentic-slack.lock.json";

const lockSlackSchema = v.strictObject({
  appId: text,
  manifestSha256: v.pipe(
    v.string(),
    v.regex(/^[0-9a-f]{64}$/u, "Expected a lower-case sha256"),
  ),
});

// `up` records what exists as it goes, so an entry survives a run that failed
// before its Worker was deployed: the D1 alone, then the Worker and its domain,
// then the Slack app once one is verified for it.
const lockEnvironmentSchema = v.strictObject({
  d1: v.strictObject({ id: text, name: text }),
  domain: v.optional(text),
  slack: v.optional(lockSlackSchema),
  worker: v.optional(text),
});

const lockSchema = v.strictObject({
  environments: v.record(text, lockEnvironmentSchema),
  version: v.literal(1),
});

export type LockEnvironment = v.InferOutput<typeof lockEnvironmentSchema>;
export type InstanceLock = v.InferOutput<typeof lockSchema>;

export const emptyLock = (): InstanceLock => ({
  environments: {},
  version: 1,
});

export const parseLock = (source: string): InstanceLock => {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `${lockFileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const result = v.safeParse(lockSchema, data);
  if (!result.success) {
    throw new Error(
      `${lockFileName} is invalid:\n${result.issues
        .map((issue) => `  ${issuePath(issue.path)}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return result.output;
};

export const serializeLock = (lock: InstanceLock): string =>
  `${JSON.stringify(
    {
      environments: Object.fromEntries(
        Object.entries(lock.environments).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      version: lock.version,
    },
    null,
    2,
  )}\n`;

export const withLockEnvironment = (
  lock: InstanceLock,
  environment: string,
  entry: LockEnvironment,
): InstanceLock => ({
  environments: { ...lock.environments, [environment]: entry },
  version: lock.version,
});

export const withoutLockEnvironment = (
  lock: InstanceLock,
  environment: string,
): InstanceLock => ({
  environments: Object.fromEntries(
    Object.entries(lock.environments).filter(([name]) => name !== environment),
  ),
  version: lock.version,
});

export const readLock = async (directory: string): Promise<InstanceLock> => {
  const file = path.join(directory, lockFileName);
  if (!(await Bun.file(file).exists())) {
    return emptyLock();
  }
  return parseLock(await Bun.file(file).text());
};

export const writeLock = async (
  directory: string,
  lock: InstanceLock,
): Promise<void> => {
  const target = path.join(directory, lockFileName);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await Bun.write(temporary, serializeLock(lock));
  await rename(temporary, target);
};

export const manifestSha256 = (manifest: string): string =>
  new Bun.CryptoHasher("sha256").update(manifest).digest("hex");
