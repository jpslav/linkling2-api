import { describe, expect, test } from "vitest";
import { createLink, getDailyCount, incrementCount, listDailyCounts } from "../src/db/links.js";
import { apiCall, appWith, countRows, seed, tempLinks } from "./support/app.js";
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

// On a machine set to UTC a local-date bug would pass the test above; this runs the
// day boundary in a zone where the local date and the UTC date differ.
test("the day is the UTC date whatever the machine's time zone", () => {
  const saved = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati"; // UTC+14
  try {
    const db = openTempDatabase();
    const now = new Date("2026-09-26T23:00:00Z"); // already 27 September in Kiritimati
    expect(now.getDate()).toBe(27);
    const link = createLink(db, { name: "q3-plan", target: "https://example.com/q3", madeBy: "sam", expiresAt: null }, now);
    incrementCount(db, link.id, now);
    expect(listDailyCounts(db, link.id)).toEqual([{ day: "2026-09-26", count: 1 }]);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
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

// R-009 and R-029 through the service: a follow is a GET on the short link.
describe("R-009 counting follows through the redirect", () => {
  test("R-009: three follows through the redirect make today's count 3", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    const now = new Date("2026-09-26T18:00:00Z");
    const app = appWith(links, { now: () => now });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/q3-plan" })).statusCode).toBe(302);

    const res = await apiCall(app, "GET", "/-/api/links/q3-plan/counts");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "q3-plan", total: 3, days: [{ day: "2026-09-26", count: 3 }] });
  });

  test("the counts are per UTC day, oldest first, with their total", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    let now = new Date("2026-09-26T23:59:59Z");
    const app = appWith(links, { now: () => now });
    await app.inject({ method: "GET", url: "/q3-plan" });
    now = new Date("2026-09-27T00:00:00Z");
    await app.inject({ method: "GET", url: "/Q3-PLAN" });
    await app.inject({ method: "GET", url: "/q3-plan" });
    const res = await apiCall(app, "GET", "/-/api/links/Q3-Plan/counts");
    expect(res.json()).toEqual({
      name: "q3-plan",
      total: 3,
      days: [
        { day: "2026-09-26", count: 1 },
        { day: "2026-09-27", count: 2 },
      ],
    });
  });

  test("a link never followed has a total of 0; an unknown one is a 404", async () => {
    const links = tempLinks();
    seed(links, "quiet", "https://example.com/q");
    const app = appWith(links);
    expect((await apiCall(app, "GET", "/-/api/links/quiet/counts")).json()).toEqual({ name: "quiet", total: 0, days: [] });
    expect((await apiCall(app, "GET", "/-/api/links/nope/counts")).statusCode).toBe(404);
  });

  // The verify line selects this with -t 'what counts'; keep that phrase in the name.
  test("R-029 what counts: a GET adds one; HEAD, 404 and 410 add none", async () => {
    const links = tempLinks();
    const live = seed(links, "live", "https://example.com/live");
    seed(links, "old", "https://example.com/old", new Date("2026-09-26T12:30:00Z"));
    seed(links, "gone", "https://example.com/gone");
    links.delete("gone");
    const app = appWith(links, { now: () => new Date("2026-09-26T13:00:00Z") });

    const answers: number[] = [];
    for (const [method, url] of [
      ["HEAD", "/live"],
      ["GET", "/old"],
      ["HEAD", "/old"],
      ["GET", "/gone"],
      ["GET", "/never-made"],
      ["GET", "/live"],
    ] as const) {
      answers.push((await app.inject({ method, url })).statusCode);
    }
    expect(answers).toEqual([302, 410, 410, 404, 404, 302]);
    expect(countRows(links)).toEqual([{ link_id: live.id, day: "2026-09-26", count: 1 }]);
  });

  test("a count that cannot be written still redirects, and logs the route only", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    links.countFollow = () => {
      throw new Error("SQLITE_FULL canary-2b9c");
    };
    const app = appWith(links);
    const res = await app.inject({ method: "GET", url: "/q3-plan?who=203.0.113.9" });
    expect([res.statusCode, res.headers.location]).toEqual([302, "https://example.com/q3"]);
    expect(app.logged).toEqual(["linkling: GET /:name count not written"]);
  });
});
