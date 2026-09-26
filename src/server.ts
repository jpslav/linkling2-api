// The process entry point. It refuses to start without the team key (ADR-0005): there is no
// default key to forget to change.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyListenOptions } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase } from "./db/open.js";
import { utcDay } from "./db/links.js";
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
  const app = buildApp({ links: await io.openLinks(), key });
  await app.listen(io.listen);
  return app;
}

export interface Running {
  app: FastifyInstance;
  /** Writes the tallied follows, stops listening (waiting at most CLOSE_WAIT_MS), writes again, closes the database. */
  close: () => Promise<void>;
}

// Five seconds past midnight UTC: late enough that the day being written is over.
const FLUSH_AFTER_MIDNIGHT_MS = 5_000;

/** How long from `now` until the next daily write of counts (ADR-0014). */
export function msUntilFlush(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) + FLUSH_AFTER_MIDNIGHT_MS;
  return next - now.getTime();
}

// How long a stop waits for requests still in flight before it writes and closes anyway.
// Docker gives a container ten seconds after SIGTERM before it kills it.
export const CLOSE_WAIT_MS = 3_000;

/** Writes the tallied follows (only days before `before`, when given), or says it could not. */
function flush(links: SqliteLinks, stderr: (line: string) => void, before?: string): void {
  try {
    links.flushCounts(before);
  } catch {
    // Nothing from the error: this runs from a timer or at shutdown, never for a request,
    // and says only that writing the counts went wrong.
    stderr("linkling: writing the daily counts failed");
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
        // Once at start, so a file written before this version (or before a migration)
        // keeps no order of writes either (ADR-0014).
        try {
          links.compact();
        } catch {
          stderr("linkling: rebuilding the database at start failed");
        }
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
  // Only the days already over: the new day's first follows wait for the next write.
  const schedule = (): void => {
    timer = setTimeout(() => {
      flush(store, stderr, utcDay(new Date()));
      schedule();
    }, msUntilFlush(new Date()));
    timer.unref();
  };
  schedule();
  let closing: Promise<void> | undefined;
  return {
    app: running,
    close: () =>
      (closing ??= (async () => {
        clearTimeout(timer);
        // Written before waiting, so a request that never finishes cannot cost the day's
        // counts; then once more for anything followed while the last requests finished.
        flush(store, stderr);
        let waited: NodeJS.Timeout | undefined;
        await Promise.race([running.close(), new Promise((done) => (waited = setTimeout(done, CLOSE_WAIT_MS)))]);
        clearTimeout(waited);
        flush(store, stderr);
        db?.close();
      })()),
  };
}

if (import.meta.main) {
  const running = await startService(process.env, (line) => console.error(line));
  if (running === null) {
    process.exitCode = 1;
  } else {
    // `docker compose down` sends SIGTERM: write the counts, give requests in flight a few
    // seconds, close the database, and leave even if a connection is still open.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => void running.close().then(() => process.exit(0)));
    }
  }
}
