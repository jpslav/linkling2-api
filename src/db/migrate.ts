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
  const migrations = readdirSync(dir)
    .flatMap((file) => {
      const match = MIGRATION_FILE.exec(file);
      return match ? [{ version: Number(match[1]), file }] : [];
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migrations must be numbered 0001 upwards with no gap or repeat; found ${m.file} at position ${i + 1}`);
    }
  });
  return migrations;
}

/**
 * Applies every numbered migration the database has not had yet, each in its own
 * transaction together with the bump of `PRAGMA user_version`, which is the only
 * record of what has run (ADR-0009): the schema stays exactly the tables the
 * migrations create. Returns the versions it applied; running it again applies none.
 */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): number[] {
  const migrations = listMigrations(dir);
  const current = db.pragma("user_version", { simple: true }) as number;
  const latest = migrations.length;
  if (current > latest) {
    throw new Error(`database is at migration ${current} but this code knows only up to ${latest}`);
  }
  const applied: number[] = [];
  for (const m of migrations.slice(current)) {
    const sql = readFileSync(`${dir}/${m.file}`, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    applied.push(m.version);
  }
  return applied;
}
