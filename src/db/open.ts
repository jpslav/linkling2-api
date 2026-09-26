import BetterSqlite3 from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { migrate } from "./migrate.js";

/** Opens the SQLite file at `path` in WAL mode and brings its schema up to date. */
export function openDatabase(path: string): Database {
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}
