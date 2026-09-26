// A name already in use is refused, and says so (R-003).
import { describe, expect, test } from "vitest";
import { MADE, apiCall, appWith, seed, tempLinks } from "./support/app.js";

describe("R-003 name clash", () => {
  test("R-003: making q3-plan twice answers 409 naming the clash, and the first still redirects", async () => {
    const app = appWith();
    const first = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/first", name: "q3-plan", made_by: "ana" });
    expect(first.statusCode).toBe(201);

    const second = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/second", name: "q3-plan", made_by: "kim" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'the name "q3-plan" is already taken' });

    const follow = await app.inject({ method: "GET", url: "/q3-plan" });
    expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/first"]);
    expect(app.links.list().map((l) => [l.name, l.target, l.madeBy])).toEqual([["q3-plan", "https://example.com/first", "ana"]]);
  });

  test("R-003: a name differing only in capitals is the same name, and is refused", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/first");
    const res = await apiCall(appWith(links), "POST", "/-/api/links", { url: "https://example.com/second", name: "Q3-PLAN" });
    expect([res.statusCode, res.json().error]).toEqual([409, 'the name "q3-plan" is already taken']);
  });

  test("R-003: an expired link keeps its name until it is deleted", async () => {
    const links = tempLinks();
    seed(links, "old", "https://example.com/old", new Date("2026-09-26T13:00:00Z"));
    const app = appWith(links, { now: () => new Date("2026-09-27T00:00:00Z") });
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/new", name: "old" });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/old" })).statusCode).toBe(410);
  });

  test("a deleted name is free at once", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/first");
    const app = appWith(links, { now: () => MADE });
    expect((await apiCall(app, "DELETE", "/-/api/links/q3-plan")).statusCode).toBe(204);
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/again", name: "q3-plan" });
    expect(res.statusCode).toBe(201);
  });
});
