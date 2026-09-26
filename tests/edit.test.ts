// A team member fixes where a link points (R-028): the target changes in place.
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { apiCall, appWith, countRows, seed, tempLinks } from "./support/app.js";

describe("R-028 edit a link's target", () => {
  test("R-028: after an edit the next follow goes to the new target, and counts and made_by stay", async () => {
    const links = tempLinks();
    const link = seed(links, "q3-plan", "https://example.com/wrong", null, { madeBy: "ana" });
    const app = appWith(links);
    await app.inject({ method: "GET", url: "/q3-plan" });
    await app.inject({ method: "GET", url: "/q3-plan" });
    const countsBefore = countRows(links);
    expect(countsBefore.map((r) => [r.link_id, r.count])).toEqual([[link.id, 2]]);

    const res = await apiCall(app, "PATCH", "/-/api/links/q3-plan", { url: "https://example.com/right" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "q3-plan", url: "https://example.com/right", made_by: "ana" });
    expect(countRows(links)).toEqual(countsBefore);

    const follow = await app.inject({ method: "GET", url: "/q3-plan" });
    expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/right"]);
    const counts = await apiCall(app, "GET", "/-/api/links/q3-plan/counts");
    expect(counts.json().total).toBe(3);
    expect(links.get("q3-plan")).toMatchObject({ id: link.id, madeBy: "ana", createdAt: link.createdAt });
  });

  test("an edit whose old target could not be cleared from the WAL still reaches the next click", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/wrong");
    // A reader holding an older snapshot keeps the checkpoint after the edit from truncating.
    const reader = new BetterSqlite3(links.db.name, { timeout: 0 });
    links.db.pragma("busy_timeout = 0");
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM links").get();
      const app = appWith(links);
      const res = await apiCall(app, "PATCH", "/-/api/links/q3-plan", { url: "https://example.com/right" });
      expect(res.statusCode).toBe(500);
      expect(app.logged).toEqual([]);
      const follow = await app.inject({ method: "GET", url: "/q3-plan" });
      expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/right"]);
    } finally {
      reader.close();
    }
  });

  test("an edit reaches the link by its name in any case", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/wrong");
    const res = await apiCall(appWith(links), "PATCH", "/-/api/links/Q3-PLAN", { url: "https://example.com/right" });
    expect([res.statusCode, res.json().url]).toEqual([200, "https://example.com/right"]);
  });

  test("editing an unknown name is a 404; a bad body is a 400 and changes nothing", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/wrong");
    const app = appWith(links);
    expect((await apiCall(app, "PATCH", "/-/api/links/nope", { url: "https://example.com/x" })).statusCode).toBe(404);
    for (const body of [{ url: "javascript:alert(1)" }, {}, { url: "https://example.com/x", name: "other" }, { url: "https://example.com/x", made_by: "kim" }]) {
      const res = await apiCall(app, "PATCH", "/-/api/links/q3-plan", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(links.get("q3-plan")).toMatchObject({ name: "q3-plan", target: "https://example.com/wrong", madeBy: "sam" });
  });
});
