import * as v from "valibot";

export interface WranglerOptions {
  cwd?: string;
  input?: string;
}

export const runWrangler = async (
  args: readonly string[],
  options: WranglerOptions = {},
): Promise<string> => {
  const child = Bun.spawn(["wrangler", ...args], {
    cwd: options.cwd,
    stderr: "pipe",
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `wrangler ${args.join(" ")} failed:\n${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout;
};

export const wranglerJson = async <T>(
  schema: v.GenericSchema<T>,
  args: readonly string[],
  options: WranglerOptions = {},
): Promise<T> => {
  const stdout = await runWrangler(args, options);
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`wrangler ${args.join(" ")} did not print JSON`, {
      cause: error,
    });
  }
  return v.parse(schema, data);
};
