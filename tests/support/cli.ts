// The `linkling` command run in-process (a function call, not a child process) against the
// real app listening on a free local port on 127.0.0.1, so the command's own `fetch` makes
// real HTTP calls to the real service over a real SQLite file.
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";
import type { AppDeps } from "../../src/app.js";
import { runCli, type CliIo } from "../../src/cli.js";
import { appWith, tempLinks } from "./app.js";
import { TEST_KEY } from "./team-key.js";

const listening: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(listening.splice(0).map((app) => app.close()));
});

export type Env = Record<string, string | undefined>;

/** What a run printed, and the exit code it ended with. */
export interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Runs the command with exactly `env`, collecting what it prints. */
export async function linkling(argv: string[], env: Env, io: Partial<CliIo> = {}): Promise<Ran> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { env, stdout: (text) => (out += text), stderr: (text) => (err += text), ...io });
  return { code, out, err };
}

/**
 * The app, listening. `run` is the command pointed at it with the team key and `USER=tester`;
 * `over` replaces or, given `undefined`, removes a variable, and `io` swaps `fetch` or `login`.
 */
export async function stack(deps: Partial<AppDeps> = {}) {
  const app = appWith(tempLinks(), deps);
  await app.listen({ port: 0, host: "127.0.0.1" });
  listening.push(app);
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const env: Env = { LINKLING_BASE: base, LINKLING_KEY: TEST_KEY, USER: "tester" };
  const run = (argv: string[], over: Env = {}, io: Partial<CliIo> = {}) => linkling(argv, { ...env, ...over }, io);
  return { app, base, env, run };
}
