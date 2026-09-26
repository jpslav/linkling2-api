// The process entry point. It refuses to start without the team key (ADR-0005): there is no
// default key to forget to change.
import type { FastifyInstance, FastifyListenOptions } from "fastify";
import { buildApp } from "./app.js";
import type { LinkLookup } from "./links.js";
import { keyProblem } from "./team-key.js";

export interface StartIo {
  stderr: (line: string) => void;
  /** Opened only once the key is known to be there. */
  openLinks: () => LinkLookup | Promise<LinkLookup>;
  listen: FastifyListenOptions;
}

/** The line the service leaves with when LINKLING_KEY cannot be used, e.g. `is not set`. */
export const refusal = (problem: string): string =>
  `linkling: LINKLING_KEY ${problem}; the service will not start without a usable team key.`;

/** Starts the service and returns it listening, or says why not and returns null. */
export async function main(env: NodeJS.ProcessEnv, io: StartIo): Promise<FastifyInstance | null> {
  const key = env.LINKLING_KEY;
  const problem = keyProblem(key);
  if (key === undefined || problem !== null) {
    io.stderr(refusal(problem ?? "is not set"));
    return null;
  }
  const app = buildApp({ links: await io.openLinks(), key });
  await app.listen(io.listen);
  return app;
}

if (import.meta.main) {
  const app = await main(process.env, {
    stderr: (line) => console.error(line),
    // Placeholder until LL-007 wires the SQLite store (src/db) and chooses the port.
    openLinks: () => {
      throw new Error("linkling: no link store is wired in yet (LL-007).");
    },
    listen: { port: 0 },
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    return null;
  });
  if (app === null) process.exitCode = 1;
}
