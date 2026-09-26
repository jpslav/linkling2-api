import { expect, test } from "vitest";
import {
  createLink,
  deleteLink,
  getLinkByName,
  incrementCount,
  listDailyCounts,
} from "../src/db/links.js";
import { apiCall, appWith, countRows, seed, tempLinks } from "./support/app.js";
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

// R-007 through the service.
test("R-007: deleting a followed link stops it at once, keeps its counts, and a remade name starts from 0", async () => {
  const links = tempLinks();
  const doomed = seed(links, "q3-plan", "https://example.com/q3");
  const app = appWith(links);
  await app.inject({ method: "GET", url: "/q3-plan" });
  await app.inject({ method: "GET", url: "/q3-plan" });
  const countsBefore = countRows(links);
  expect(countsBefore.map((r) => [r.link_id, r.count])).toEqual([[doomed.id, 2]]);

  const res = await apiCall(app, "DELETE", "/-/api/links/Q3-Plan");
  expect([res.statusCode, res.body]).toEqual([204, ""]);

  const follow = await app.inject({ method: "GET", url: "/q3-plan" });
  expect([follow.statusCode, follow.headers.location]).toEqual([404, undefined]);
  expect(links.db.prepare("SELECT * FROM links WHERE id = ?").all(doomed.id)).toEqual([]);
  expect(countRows(links)).toEqual(countsBefore);
  expect((await apiCall(app, "GET", "/-/api/links/q3-plan/counts")).statusCode).toBe(404);

  const remade = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/new", name: "q3-plan", made_by: "kim" });
  expect(remade.statusCode).toBe(201);
  expect((await apiCall(app, "GET", "/-/api/links/q3-plan/counts")).json()).toEqual({ name: "q3-plan", total: 0, days: [] });
});

test("deleting an unknown name through the API is a 404", async () => {
  const res = await apiCall(appWith(), "DELETE", "/-/api/links/nope");
  expect([res.statusCode, typeof res.json().error]).toEqual([404, "string"]);
});
