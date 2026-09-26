import { expect, test } from "vitest";
import { createLink, getDailyCount, incrementCount, listDailyCounts } from "../src/db/links.js";
import { openTempDatabase } from "./temp-db.js";

// R-009, data-layer half: here a follow is incrementCount; following through the
// redirect route is LL-007's.
test("three follows make today's count 3", () => {
  const db = openTempDatabase();
  const now = new Date("2026-09-26T23:59:59Z");
  const link = createLink(db, { name: "q3-plan", target: "https://example.com/q3", madeBy: "sam", expiresAt: null }, now);

  incrementCount(db, link.id, now);
  incrementCount(db, link.id, now);
  incrementCount(db, link.id, now);

  expect(getDailyCount(db, link.id, "2026-09-26")).toBe(3);
  expect(listDailyCounts(db, link.id)).toEqual([{ day: "2026-09-26", count: 3 }]);
});

test("a follow just after midnight UTC counts toward the new day", () => {
  const db = openTempDatabase();
  const link = createLink(db, { name: "q3-plan", target: "https://example.com/q3", madeBy: "sam", expiresAt: null }, new Date("2026-09-26T12:00:00Z"));

  incrementCount(db, link.id, new Date("2026-09-26T23:59:59.999Z"));
  incrementCount(db, link.id, new Date("2026-09-27T00:00:00Z"));

  expect(listDailyCounts(db, link.id)).toEqual([
    { day: "2026-09-26", count: 1 },
    { day: "2026-09-27", count: 1 },
  ]);
});

// R-009: the only thing recorded about a click is which link, which day, how many.
// Adding any column, or a foreign key that would tie counts to a live link, fails this.
test("the counts table holds nothing but link, day and count", () => {
  const db = openTempDatabase();
  const columns = db
    .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('daily_counts') ORDER BY cid")
    .all();
  expect(columns).toEqual([
    { name: "link_id", type: "INTEGER", notnull: 1, pk: 1 },
    { name: "day", type: "TEXT", notnull: 1, pk: 2 },
    { name: "count", type: "INTEGER", notnull: 1, pk: 0 },
  ]);
  expect(db.prepare("SELECT * FROM pragma_foreign_key_list('daily_counts')").all()).toEqual([]);
});
