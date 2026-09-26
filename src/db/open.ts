import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { migrate } from "./migrate.js";

const WAL_RETRY_WINDOW_MS = 5000;
const WAL_RETRY_MS = 100;

/**
 * Switching a new file to WAL needs a lock SQLite's busy timeout does not wait for,
 * so a second process opening the same fresh file at the same moment gets
 * SQLITE_BUSY at once. Retry until five seconds have passed, then give up. The
 * window is time, not a count of attempts, because an attempt can itself wait out
 * the busy timeout when another connection holds an exclusive lock.
 */
function enableWal(db: Database): void {
  const deadline = Date.now() + WAL_RETRY_WINDOW_MS;
  for (;;) {
    try {
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      if (mode !== "wal") throw new Error(`journal_mode is ${String(mode)}, not wal`);
      return;
    } catch (err) {
      if ((err as { code?: unknown }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAL_RETRY_MS);
    }
  }
}

/** Opens the SQLite file at `path` in WAL mode and brings its schema up to date. */
export function openDatabase(path: string): Database {
  const db = new BetterSqlite3(path);
  try {
    enableWal(db);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
