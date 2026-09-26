import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";

// The same relative path from src/db/ (under Vitest) and from dist/db/ (after tsc).
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const MIGRATION_FILE = /^(\d{4})_[^/]*\.sql$/;

interface Migration {
  version: number;
  file: string;
}

function listMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const match = MIGRATION_FILE.exec(file);
    if (match) {
      migrations.push({ version: Number(match[1]), file });
    } else if (file.endsWith(".sql")) {
      // A misnamed migration would otherwise never run, and start-up would still succeed.
      throw new Error(`${file} is not named NNNN_<what>.sql, so it would never run`);
    }
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migrations must be numbered 0001 upwards with no gap or repeat; found ${m.file} at position ${i + 1}`);
    }
  });
  return migrations;
}

function userVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Applies every numbered migration the database has not had yet, each in its own
 * transaction together with the bump of `PRAGMA user_version`, which is the only
 * record of what has run (ADR-0009): the schema stays exactly the tables the
 * migrations create. Returns the versions it applied; running it again applies none.
 */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): number[] {
  const migrations = listMigrations(dir);
  const latest = migrations.length;
  const checkVersion = (current: number): void => {
    if (current < 0 || current > latest) {
      throw new Error(`database is at migration ${current} but this code knows only 0 to ${latest}`);
    }
  };
  checkVersion(userVersion(db));
  const applied: number[] = [];
  for (const m of migrations) {
    // IMMEDIATE takes the write lock before reading the version, so a second process
    // starting at the same moment waits and then sees this migration as already done.
    db.transaction(() => {
      const current = userVersion(db);
      checkVersion(current);
      if (current >= m.version) return;
      db.exec(readFileSync(`${dir}/${m.file}`, "utf8"));
      db.pragma(`user_version = ${m.version}`);
      applied.push(m.version);
    }).immediate();
  }
  return applied;
}
