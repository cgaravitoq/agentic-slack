import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emptyLock,
  lockFileName,
  manifestSha256,
  parseLock,
  readLock,
  serializeLock,
  withLockEnvironment,
  withoutLockEnvironment,
  writeLock,
} from "../../../packages/core/src/lock.ts";
import type { InstanceLock } from "../../../packages/core/src/lock.ts";

const prod = {
  d1: { id: "22222222-2222-2222-2222-222222222222", name: "instance" },
  slack: { appId: "A0000000002", manifestSha256: "2".repeat(64) },
  worker: "instance",
};

const staging = {
  d1: { id: "11111111-1111-1111-1111-111111111111", name: "instance-staging" },
  slack: {
    appId: "A0000000001",
    manifestSha256: "1".repeat(64),
  },
  worker: "instance-staging",
};

const lock: InstanceLock = {
  environments: { prod, staging },
  version: 1,
};

const temporaryDirectory = async (): Promise<string> =>
  await mkdtemp(path.join(tmpdir(), "agentic-slack-lock-"));

describe("lock", () => {
  test("round-trips and keeps a stable key order", () => {
    const serialized = serializeLock(lock);

    expect(parseLock(serialized)).toEqual(lock);
    expect(serialized).toBe(`{
  "environments": {
    "prod": {
      "d1": {
        "id": "22222222-2222-2222-2222-222222222222",
        "name": "instance"
      },
      "slack": {
        "appId": "A0000000002",
        "manifestSha256": "${"2".repeat(64)}"
      },
      "worker": "instance"
    },
    "staging": {
      "d1": {
        "id": "11111111-1111-1111-1111-111111111111",
        "name": "instance-staging"
      },
      "slack": {
        "appId": "A0000000001",
        "manifestSha256": "${"1".repeat(64)}"
      },
      "worker": "instance-staging"
    }
  },
  "version": 1
}
`);
  });

  test("keeps the entry of every environment while adding one", () => {
    const both = withLockEnvironment(
      withLockEnvironment(emptyLock(), "staging", staging),
      "prod",
      prod,
    );

    expect(parseLock(serializeLock(both))).toEqual(lock);
  });

  test("rejects a malformed lock with its path", () => {
    const failures: readonly (readonly [string, RegExp])[] = [
      ["not JSON at all", /not valid JSON/u],
      [
        JSON.stringify({ ...lock, version: 2 }),
        /version: Invalid type: Expected 1/u,
      ],
      [
        JSON.stringify({
          ...lock,
          environments: {
            staging: {
              ...staging,
              slack: { ...staging.slack, manifestSha256: "nope" },
            },
          },
        }),
        /environments\.staging\.slack\.manifestSha256: Expected a lower-case sha256/u,
      ],
      [
        JSON.stringify({
          ...lock,
          environments: { staging: { d1: staging.d1, slack: staging.slack } },
        }),
        /environments\.staging\.worker: Invalid key/u,
      ],
    ];
    for (const [source, expected] of failures) {
      expect(() => parseLock(source), source).toThrow(expected);
    }
  });

  test("keeps an entry that has no Slack app yet", () => {
    const provisioned = {
      d1: { id: "33333333-3333-3333-3333-333333333333", name: "instance" },
      worker: "instance",
    };
    const updated = withLockEnvironment(lock, "preview", provisioned);

    const serialized = serializeLock(updated);

    expect(serialized).toContain('"preview"');
    expect(serialized).not.toContain('"slack": null');
    expect(parseLock(serialized).environments.preview).toEqual(provisioned);
  });

  test("drops only the named environment", () => {
    expect(withoutLockEnvironment(lock, "staging")).toEqual({
      environments: { prod },
      version: 1,
    });
    expect(withoutLockEnvironment(lock, "absent")).toEqual(lock);
  });

  test("writes atomically and reads back what it wrote", async () => {
    const directory = await temporaryDirectory();
    const updated = withLockEnvironment(lock, "staging", {
      ...staging,
      worker: "instance-staging-2",
    });

    await writeLock(directory, updated);

    expect(await readLock(directory)).toEqual(updated);
    expect(await readdir(directory)).toEqual([lockFileName]);

    await writeLock(directory, lock);

    expect(await readLock(directory)).toEqual(lock);
    expect(await readdir(directory)).toEqual([lockFileName]);
  });

  test("reads a missing lock as empty and rejects a broken one", async () => {
    const directory = await temporaryDirectory();

    expect(await readLock(directory)).toEqual(emptyLock());

    await writeFile(path.join(directory, lockFileName), "{");

    let message = "";
    try {
      await readLock(directory);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not valid JSON/u);
  });

  test("hashes a manifest as lower-case sha256", () => {
    expect(manifestSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
