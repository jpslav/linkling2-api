import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, test } from "vitest";
import { createLink, deleteLink, getLinkByName, incrementCount, setTarget } from "../src/db/links.js";
import { openDatabase } from "../src/db/open.js";
import { tempDir } from "./temp-db.js";

// R-022 and principle promises-literal (ADR-0012): the privacy page says a link's name,
// target, maker, creation time and expiry are kept "until the link is deleted", and that
// a deleted link's counts are "tied to no name". That is a claim about the bytes on disk,
// so this reads them: the database file and everything SQLite keeps beside it.

// Distinctive values for all five things the page says go with the link. The long target
// spills onto overflow pages, which SQLite frees separately from the row's own page.
const created = new Date("2031-07-19T13:57:41.123Z");
const expires = new Date("2037-03-05T08:09:10.456Z");
const target = `https://canary-target.example/7e21?${"x".repeat(12_000)}canary-target-tail-91d0`;
// The target is split across pages, so its start and its end are looked for separately.
const canary = {
  name: "canary-name-3f9a",
  targetStart: "https://canary-target.example/7e21",
  targetEnd: "canary-target-tail-91d0",
  madeBy: "canary-maker-c40b",
  createdAt: created.toISOString(),
  expiresAt: expires.toISOString(),
};

function fileBytes(dbPath: string): Buffer {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].filter((f) => existsSync(f));
  return Buffer.concat(files.map((f) => readFileSync(f)));
}

function found(bytes: Buffer): string[] {
  return Object.entries(canary)
    .filter(([, value]) => bytes.includes(value))
    .map(([what]) => what);
}

const ALL = ["name", "targetStart", "targetEnd", "madeBy", "createdAt", "expiresAt"];

function makeCanary(db: BetterSqlite3.Database): void {
  const link = createLink(db, { name: canary.name, target, madeBy: canary.madeBy, expiresAt: expires }, created);
  incrementCount(db, link.id, created);
}

test("a deleted link leaves no copy of anything stored about it in the database files", () => {
  const dbPath = join(tempDir(), "linkling.db");
  const db = openDatabase(dbPath);
  try {
    // Enough links on either side that the name index spans several pages and the canary
    // is deleted from the middle of it.
    const other = { target: "https://example.com/", madeBy: "sam", expiresAt: null };
    for (let i = 0; i < 1500; i++) createLink(db, { ...other, name: `a-${i}` }, new Date("2026-09-26T12:00:00Z"));
    makeCanary(db);
    for (let i = 0; i < 1500; i++) createLink(db, { ...other, name: `z-${i}` }, new Date("2026-09-26T12:00:00Z"));
    // Blind arm: the scan must see the link while it exists, or its silence below means
    // nothing.
    expect(found(fileBytes(dbPath)), "blind: the scan cannot see a live link").toEqual(ALL);

    expect(deleteLink(db, canary.name)).toBe(true);
    // While the service is still running, not only after it closes the file.
    expect(found(fileBytes(dbPath)), "after the delete, with the database open").toEqual([]);
    expect(getLinkByName(db, "a-0")).toBeDefined();
  } finally {
    db.close();
  }
  expect(found(fileBytes(dbPath)), "after the delete, with the database closed").toEqual([]);
});

test("a delete whose WAL copy cannot be removed says so instead of passing silently", () => {
  const dbPath = join(tempDir(), "linkling.db");
  const db = openDatabase(dbPath);
  const reader = new BetterSqlite3(dbPath, { timeout: 0 });
  db.pragma("busy_timeout = 0");
  try {
    makeCanary(db);
    // A reader holding an older snapshot keeps the checkpoint from truncating the WAL.
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM links").get();
    expect(() => deleteLink(db, canary.name)).toThrow(/old bytes remain/);
    expect(getLinkByName(db, canary.name), "the delete itself still happened").toBeUndefined();
  } finally {
    reader.close();
    db.close();
  }
});

// R-028's edit overwrites the target, which ADR-0012 treats like a delete of the old one.
test("an edited target leaves no copy of the old one in the database files", () => {
  const dbPath = join(tempDir(), "linkling.db");
  const db = openDatabase(dbPath);
  const old = { targetStart: canary.targetStart, targetEnd: canary.targetEnd };
  const oldFound = (bytes: Buffer) => Object.entries(old).filter(([, v]) => bytes.includes(v)).map(([k]) => k);
  try {
    makeCanary(db);
    expect(oldFound(fileBytes(dbPath)), "blind: the scan cannot see the target before the edit").toEqual(["targetStart", "targetEnd"]);

    expect(setTarget(db, canary.name, "https://example.com/fixed")?.target).toBe("https://example.com/fixed");
    expect(oldFound(fileBytes(dbPath)), "after the edit, with the database open").toEqual([]);
    expect(found(fileBytes(dbPath)), "the rest of the link is still there").toEqual(["name", "madeBy", "createdAt", "expiresAt"]);
  } finally {
    db.close();
  }
  expect(oldFound(fileBytes(dbPath)), "after the edit, with the database closed").toEqual([]);
});

test("an edit whose WAL copy cannot be removed says so, and setTarget refuses a transaction", () => {
  const dbPath = join(tempDir(), "linkling.db");
  const db = openDatabase(dbPath);
  const reader = new BetterSqlite3(dbPath, { timeout: 0 });
  db.pragma("busy_timeout = 0");
  try {
    makeCanary(db);
    expect(() => db.transaction(() => setTarget(db, canary.name, "https://example.com/a"))()).toThrow(/inside a transaction/);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM links").get();
    expect(() => setTarget(db, canary.name, "https://example.com/b")).toThrow(/old target remains/);
    expect(getLinkByName(db, canary.name)?.target, "the edit itself still happened").toBe("https://example.com/b");
  } finally {
    reader.close();
    db.close();
  }
});

test("deleteLink refuses to run inside a transaction, where its checkpoint cannot", () => {
  const db = openDatabase(join(tempDir(), "linkling.db"));
  try {
    makeCanary(db);
    expect(() => db.transaction(() => deleteLink(db, canary.name))()).toThrow(/inside a transaction/);
    expect(getLinkByName(db, canary.name)).toBeDefined();
  } finally {
    db.close();
  }
});
