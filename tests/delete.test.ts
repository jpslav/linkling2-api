import { expect, test } from "vitest";
import {
  createLink,
  deleteLink,
  getLinkByName,
  incrementCount,
  listDailyCounts,
} from "../src/db/links.js";
import { openTempDatabase } from "./temp-db.js";

const day1 = new Date("2026-09-26T09:00:00Z");
const day2 = new Date("2026-09-27T09:00:00Z");

// R-007, data-layer half: the 404 on following a deleted link is the route's (LL-007).
test("deleting a link removes its row and keeps its counts under an id never reused", () => {
  const db = openTempDatabase();
  createLink(db, { name: "older", target: "https://example.com/a", madeBy: "sam", expiresAt: null }, day1);
  // The newest link, so its id is the highest: plain INTEGER PRIMARY KEY would hand it out again.
  const doomed = createLink(db, { name: "q3-plan", target: "https://example.com/q3", madeBy: "sam", expiresAt: null }, day1);
  incrementCount(db, doomed.id, day1);
  incrementCount(db, doomed.id, day1);
  incrementCount(db, doomed.id, day2);
  const countsBefore = db.prepare("SELECT * FROM daily_counts ORDER BY link_id, day").all();

  expect(deleteLink(db, "q3-plan")).toBe(true);

  expect(db.prepare("SELECT * FROM links WHERE id = ?").all(doomed.id)).toEqual([]);
  expect(getLinkByName(db, "q3-plan")).toBeUndefined();
  expect(db.prepare("SELECT * FROM daily_counts ORDER BY link_id, day").all()).toEqual(countsBefore);
  expect(listDailyCounts(db, doomed.id)).toEqual([
    { day: "2026-09-26", count: 2 },
    { day: "2026-09-27", count: 1 },
  ]);

  const reborn = createLink(db, { name: "q3-plan", target: "https://example.com/new", madeBy: "kim", expiresAt: null }, day2);
  expect(reborn.id).not.toBe(doomed.id);
  expect(listDailyCounts(db, reborn.id)).toEqual([]);
});

test("deleting a name that does not exist reports false", () => {
  const db = openTempDatabase();
  expect(deleteLink(db, "nope")).toBe(false);
});
