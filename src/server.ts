// The process entry point. It refuses to start without the team key (ADR-0005): there is no
// default key to forget to change.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyListenOptions } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/open.js";
import { SqliteLinks, type LinkStore } from "./store.js";
import { keyProblem } from "./team-key.js";

export interface StartIo {
  stderr: (line: string) => void;
  /** Opened only once the key is known to be there. */
  openLinks: () => LinkStore | Promise<LinkStore>;
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
  const app = buildApp({ links: await io.openLinks(), key, log: io.stderr });
  await app.listen(io.listen);
  return app;
}

export interface Running {
  app: FastifyInstance;
  /** Stops listening, writes the day's tallied follows, then closes the database. */
  close: () => Promise<void>;
}

// Five seconds past midnight UTC: late enough that the day being written is over.
const FLUSH_AFTER_MIDNIGHT_MS = 5_000;

/** How long from `now` until the next daily write of counts (ADR-0014). */
export function msUntilFlush(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) + FLUSH_AFTER_MIDNIGHT_MS;
  return next - now.getTime();
}

/** Writes the tallied follows; a failure keeps them for the next write and says so. */
function flush(links: SqliteLinks, stderr: (line: string) => void): void {
  try {
    links.flushCounts();
  } catch {
    // Nothing from the store's error: ADR-0004 logs a fault's place and nothing else.
    stderr("linkling: daily counts not written; kept for the next write");
  }
}

/**
 * The service as `node dist/server.js` runs it: the database is `linkling.db` in
 * LINKLING_DATA (default `./data`), opened once here and never from a request, and the
 * service listens on every interface at PORT (default 8080).
 */
export async function startService(env: NodeJS.ProcessEnv, stderr: (line: string) => void): Promise<Running | null> {
  const portText = env.PORT ?? "8080";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 0 && port <= 65535)) {
    stderr(`linkling: PORT must be a port number from 0 to 65535, not "${portText}".`);
    return null;
  }
  const dataDir = env.LINKLING_DATA ?? "data";
  let db: Database | undefined;
  let links: SqliteLinks | undefined;
  let app: FastifyInstance | null;
  try {
    app = await main(env, {
      stderr,
      openLinks: () => {
        try {
          mkdirSync(dataDir, { recursive: true });
          db = openDatabase(join(dataDir, "linkling.db"));
        } catch (err) {
          throw new Error(`linkling: could not open the database in ${dataDir}: ${(err as Error).message}`);
        }
        links = new SqliteLinks(db);
        return links;
      },
      listen: { port, host: "0.0.0.0" },
    });
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    app = null;
  }
  if (app === null) {
    db?.close();
    return null;
  }
  const running = app;
  const store = links!;
  // The day's follows are written once, just after it ends (ADR-0014).
  let timer: NodeJS.Timeout;
  const schedule = (): void => {
    timer = setTimeout(() => {
      flush(store, stderr);
      schedule();
    }, msUntilFlush(new Date()));
    timer.unref();
  };
  schedule();
  return {
    app: running,
    close: async () => {
      clearTimeout(timer);
      await running.close();
      flush(store, stderr);
      db?.close();
    },
  };
}

if (import.meta.main) {
  const running = await startService(process.env, (line) => console.error(line));
  if (running === null) {
    process.exitCode = 1;
  } else {
    // `docker compose down` sends SIGTERM: finish what is in flight and close the database.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => void running.close());
    }
  }
}
