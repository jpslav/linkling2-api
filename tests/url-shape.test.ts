// The shape of a printed link (ADR-0001). Changing anything pinned here breaks links
// that are already on posters and slides.
import { describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { MADE_UP_ALPHABET, MADE_UP_LENGTH, normalizeName } from "../src/names.js";
import { MemoryLinks } from "./support/memory-links.js";

const TARGET = "https://example.com/q3";

function appWith(links = new MemoryLinks().make("q3-plan", TARGET)) {
  return { app: buildApp({ links }), links };
}

test("case folding: /Q3-PLAN and /q3-plan redirect to the same Location", async () => {
  const { app } = appWith();
  const upper = await app.inject({ method: "GET", url: "/Q3-PLAN" });
  const lower = await app.inject({ method: "GET", url: "/q3-plan" });
  expect(upper.statusCode).toBe(302);
  expect(lower.statusCode).toBe(302);
  expect(lower.headers.location).toBe(TARGET);
  expect(upper.headers.location).toBe(lower.headers.location);
});

test("R-004: chosen names are 1–64 of a-z 0-9 -, not starting with -, stored lower-case", () => {
  const cases: [string, string | null][] = [
    ["q3-plan", "q3-plan"],
    ["Q3-Plan", "q3-plan"],
    ["a", "a"],
    ["9-to-5", "9-to-5"],
    ["x".repeat(64), "x".repeat(64)],
    ["x".repeat(65), null],
    ["", null],
    ["-x", null],
    ["-", null],
    ["q3_plan", null],
    ["q3.plan", null],
    ["q3 plan", null],
    ["K", null], // KELVIN SIGN lower-cases to ASCII "k"; refused before that happens
    ["café", null],
  ];
  expect(cases.map(([raw]) => [raw, normalizeName(raw)])).toEqual(cases);
});

describe("R-026 shape lock", () => {
  test("made-up alphabet is abcdefghjkmnpqrstuvwxyz23456789, length 6", () => {
    expect(MADE_UP_ALPHABET).toBe("abcdefghjkmnpqrstuvwxyz23456789");
    expect(MADE_UP_LENGTH).toBe(6);
  });

  test("/<name> redirects", async () => {
    const res = await appWith().app.inject({ method: "GET", url: "/q3-plan" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(TARGET);
  });

  test("every service route starts with /-/", async () => {
    const app = buildApp({ links: new MemoryLinks() });
    // A later item's route under /-/ is accepted; one at the root is refused when made.
    app.get("/-/probe", async () => "ok");
    expect(() => app.get("/privacy", async () => "no")).toThrow("route /privacy is outside /-/");
    expect(() => app.post("/links", async () => "no")).toThrow("route /links is outside /-/");
    await app.ready();
    expect(app.hasRoute({ method: "GET", url: "/:name" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/-/probe" })).toBe(true);
    expect(app.hasRoute({ method: "GET", url: "/privacy" })).toBe(false);
  });

  test("a name starting with - is refused", async () => {
    expect(normalizeName("-x")).toBeNull();
    const { app, links } = appWith(new MemoryLinks().make("-x", TARGET));
    const res = await app.inject({ method: "GET", url: "/-x" });
    expect(res.statusCode).toBe(404);
    expect(links.lookups).toBe(0);
  });

  test("trailing slash opens the same link", async () => {
    const res = await appWith().app.inject({ method: "GET", url: "/q3-plan/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(TARGET);
  });

  test("extra path segments answer 404", async () => {
    const { app } = appWith();
    for (const url of ["/q3-plan/more", "/-/nothing-here", "/a/b/c"]) {
      const res = await app.inject({ method: "GET", url });
      expect([url, res.statusCode, res.headers.location]).toEqual([url, 404, undefined]);
      expect(res.body).toBe("No such link.\n");
    }
  });

  test("a query string is not passed on", async () => {
    const res = await appWith().app.inject({ method: "GET", url: "/q3-plan?to=https://evil.example/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(TARGET);
  });

  test("/ answers a plain page naming the product", async () => {
    const res = await appWith().app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toBe("Linkling\n");
  });
});
