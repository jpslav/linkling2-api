import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLink, deleteLink, incrementCount } from "../src/db/links.js";
import { openDatabase } from "../src/db/open.js";
import { tempDir } from "./temp-db.js";

// R-022 and principle promises-literal (ADR-0012): the privacy page says a link's name,
// target, maker, creation time and expiry are kept "until the link is deleted", and that
// a deleted link's counts are "tied to no name". That is a claim about the bytes on disk,
// so this reads them: the database file and everything SQLite keeps beside it.

const canary = {
  name: "canary-name-3f9a",
  target: "https://canary-target.example/7e21",
  madeBy: "canary-maker-c40b",
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

test("a deleted link leaves no copy of its name, target or maker in the database files", () => {
  const dbPath = join(tempDir(), "linkling.db");
  const db = openDatabase(dbPath);
  try {
    const now = new Date("2026-09-26T12:00:00Z");
    const link = createLink(db, { ...canary, expiresAt: null }, now);
    incrementCount(db, link.id, now);
    // Blind arm: the scan must see the link while it exists, or its silence below means
    // nothing.
    expect(found(fileBytes(dbPath)), "blind: the scan cannot see a live link").toEqual(["name", "target", "madeBy"]);

    expect(deleteLink(db, canary.name)).toBe(true);
    // While the service is still running, not only after it closes the file.
    expect(found(fileBytes(dbPath)), "after the delete, with the database open").toEqual([]);
  } finally {
    db.close();
  }
  expect(found(fileBytes(dbPath)), "after the delete, with the database closed").toEqual([]);
});
