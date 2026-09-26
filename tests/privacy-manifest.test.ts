import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { openTempDatabase, tempDir } from "./temp-db.js";

// R-022, service half (ADR-0004, ADR-0011): privacy-manifest.json names every column the
// database holds, SQLite's own sqlite_sequence included, and nothing it does not hold.
// linkling-web's privacy page copies the manifest's text, so a column added here without
// a manifest entry would be stored and never promised.

interface Entry {
  id: string;
  fields: string[];
  what: string;
  kept: string;
}

interface Manifest {
  about: string;
  stored: Entry[];
  counted: string;
  logged: string;
}

const MANIFEST_PATH = new URL("../privacy-manifest.json", import.meta.url);

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

/** Every column of every table in the file, as `table.column`, sorted. */
function schemaFields(db: Database): string[] {
  const tables = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  return tables
    .flatMap((t) =>
      db
        .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
        .all(t)
        .map((c) => `${t}.${c.name}`),
    )
    .sort();
}

/** What the schema holds that the manifest does not list, and the reverse. */
function compare(db: Database, manifest: Manifest): { unlisted: string[]; absent: string[] } {
  const inSchema = new Set(schemaFields(db));
  const listed = new Set(manifest.stored.flatMap((e) => e.fields));
  return {
    unlisted: [...inSchema].filter((f) => !listed.has(f)),
    absent: [...listed].filter((f) => !inSchema.has(f)).sort(),
  };
}

test("the manifest lists exactly the columns the migrations create", () => {
  const db = openTempDatabase();
  const fields = schemaFields(db);
  // Blind guards: an enumeration that found nothing, or missed SQLite's own table
  // (created by AUTOINCREMENT, tests/db.test.ts), would pass the comparison vacuously.
  expect(fields.length, "blind: the schema enumeration found no columns").toBeGreaterThan(0);
  expect(fields, "blind: sqlite_sequence was not enumerated").toContain("sqlite_sequence.seq");
  expect(compare(db, readManifest())).toEqual({ unlisted: [], absent: [] });
});

test("the file holds only tables and their indexes, so the column list is all it stores", () => {
  const db = openTempDatabase();
  // A view or a trigger is not a column the enumeration above would see.
  const kinds = db
    .prepare<[], { type: string }>("SELECT DISTINCT type FROM sqlite_schema ORDER BY type")
    .all()
    .map((r) => r.type);
  expect(kinds).toEqual(["index", "table"]);
});

test("every entry has an id, fields and the text the privacy page copies", () => {
  const manifest = readManifest();
  expect(manifest.stored.length).toBeGreaterThan(0);
  for (const text of [manifest.about, manifest.counted, manifest.logged]) {
    expect(typeof text === "string" && text.trim().length > 0).toBe(true);
  }
  const ids = manifest.stored.map((e) => e.id);
  expect(new Set(ids).size, "an id is used twice").toBe(ids.length);
  const fields = manifest.stored.flatMap((e) => e.fields);
  expect(new Set(fields).size, "a field is listed twice").toBe(fields.length);
  for (const e of manifest.stored) {
    expect(e.id, JSON.stringify(e)).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(e.fields.length, e.id).toBeGreaterThan(0);
    expect(e.what.trim().length, e.id).toBeGreaterThan(0);
    expect(e.kept.trim().length, e.id).toBeGreaterThan(0);
  }
});

// The comparison itself, tried on a schema and a manifest that disagree, so a green run
// above means they agree rather than that compare() cannot see a difference.
test("a new column the manifest does not list, or an entry the schema lacks, is reported", () => {
  const dir = tempDir();
  for (const f of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  writeFileSync(join(dir, "0002_scratch.sql"), "ALTER TABLE links ADD COLUMN clicker_ip TEXT;\n");
  const db = new BetterSqlite3(join(dir, "scratch.db"));
  try {
    migrate(db, dir);
    const manifest = readManifest();
    expect(compare(db, manifest)).toEqual({ unlisted: ["links.clicker_ip"], absent: [] });
    const withoutTarget = { ...manifest, stored: manifest.stored.filter((e) => e.id !== "link-target") };
    const extra = { ...manifest, stored: [...manifest.stored, { id: "x", fields: ["links.referrer"], what: "x", kept: "x" }] };
    expect(compare(db, withoutTarget).unlisted).toEqual(["links.clicker_ip", "links.target"]);
    expect(compare(db, extra).absent).toEqual(["links.referrer"]);
  } finally {
    db.close();
  }
});
