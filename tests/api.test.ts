// The team API under /-/api/ (ADR-0012): making, listing and reading links.
import { describe, expect, test } from "vitest";
import { MADE, apiCall, appWith, seed, tempLinks } from "./support/app.js";
import { TEST_KEY } from "./support/team-key.js";

describe("R-001 a team member makes a short link under a name they choose", () => {
  test("R-001: R-001's own body makes q3-plan, and q3-plan then leads to the URL", async () => {
    const app = appWith(tempLinks(), { now: () => MADE });
    // R-001's verify line sends exactly this, with no made_by.
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/a", name: "q3-plan" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.json()).toEqual({
      name: "q3-plan",
      url: "https://example.com/a",
      made_by: "",
      created_at: "2026-09-26T12:00:00.000Z",
      expires_at: null,
      expired: false,
    });
    const follow = await app.inject({ method: "GET", url: "/q3-plan" });
    expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/a"]);
  });

  test("a URL is stored in its encoded form, so the redirect can always carry it", async () => {
    const app = appWith();
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/café?q=a b", name: "cafe" });
    expect(res.json().url).toBe("https://example.com/caf%C3%A9?q=a%20b");
    const follow = await app.inject({ method: "GET", url: "/cafe" });
    expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/caf%C3%A9?q=a%20b"]);
  });

  test("made_by is kept as given, trimmed", async () => {
    const app = appWith();
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/a", made_by: "  ana " });
    expect(res.json().made_by).toBe("ana");
  });

  test("made_by keeps the joiners that emoji and Persian spelling need", async () => {
    const app = appWith();
    for (const madeBy of ["👨‍👩‍👧 team", "دانش‌آموز", "🎉 party"]) {
      const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/a", made_by: madeBy });
      expect([madeBy, res.statusCode, res.json().made_by]).toEqual([madeBy, 201, madeBy]);
    }
  });
});

describe("a body the API cannot use is refused with a 400 and stores nothing", () => {
  const url = "https://example.com/a";
  const refused: [string, unknown, string][] = [
    ["no url", {}, "url"],
    ["url not a string", { url: 5 }, "url"],
    ["url not a URL", { url: "not a url" }, "url"],
    ["ftp url", { url: "ftp://example.com/a" }, "http"],
    ["javascript url", { url: "javascript:alert(1)" }, "http"],
    ["url too long", { url: `https://example.com/${"x".repeat(2040)}` }, "2048"],
    ["name starting with -", { url, name: "-x" }, "name"],
    ["name with _", { url, name: "q3_plan" }, "name"],
    ["name not a string", { url, name: 5 }, "name"],
    ["made_by not a string", { url, made_by: 5 }, "made_by"],
    ["made_by too long", { url, made_by: "x".repeat(65) }, "made_by"],
    ["made_by with a line break", { url, made_by: "a\nb" }, "made_by"],
    ["made_by with a C1 control", { url, made_by: "a\u0085b" }, "made_by"],
    ["made_by with a right-to-left override", { url, made_by: "a‮b" }, "made_by"],
    ["made_by with a line separator", { url, made_by: "a b" }, "made_by"],
    ["expires a word", { url, expires: "tomorrow" }, "expires"],
    ["expires not a real date", { url, expires: "2026-02-30" }, "expires"],
    ["expires a zero lifetime", { url, expires: "0d" }, "expires"],
    ["expires in weeks", { url, expires: "2w" }, "expires"],
    ["expires already past", { url, expires: "2026-09-25" }, "past"],
    ["an unknown field", { url, expiry: "7d" }, "expiry"],
    ["an array", [url], "object"],
    ["a string", url, "object"],
    ["null", null, "object"],
  ];
  for (const [label, body, mentions] of refused) {
    test(`refused: ${label}`, async () => {
      const app = appWith(tempLinks(), { now: () => MADE });
      const res = await apiCall(app, "POST", "/-/api/links", body);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toContain(mentions);
      expect(app.links.list()).toEqual([]);
    });
  }

  test("a body that is not JSON, or not an object, is a JSON 400; an unreadable type a JSON 415", async () => {
    const app = appWith();
    const bad = await app.inject({
      method: "POST",
      url: "/-/api/links",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: "{not json",
    });
    expect([bad.statusCode, typeof bad.json().error]).toEqual([400, "string"]);
    // Fastify reads text/plain as a string, which is then not an object.
    const text = await app.inject({
      method: "POST",
      url: "/-/api/links",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "text/plain" },
      payload: "https://example.com/a",
    });
    expect([text.statusCode, text.json().error]).toEqual([400, "the body must be a JSON object"]);
    const xml = await app.inject({
      method: "POST",
      url: "/-/api/links",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/xml" },
      payload: "<url>https://example.com/a</url>",
    });
    expect([xml.statusCode, xml.json().error]).toEqual([415, "send the body as application/json"]);
    const empty = await app.inject({
      method: "POST",
      url: "/-/api/links",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: "",
    });
    expect([empty.statusCode, empty.json().error]).toEqual([400, "the body must be a JSON object"]);
    expect(app.logged).toEqual([]);
  });

  test("a DELETE sent with a JSON content type and no body still deletes", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    const res = await appWith(links).inject({
      method: "DELETE",
      url: "/-/api/links/q3-plan",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(204);
    expect(links.get("q3-plan")).toBeNull();
  });
});

describe("listing and reading links", () => {
  test("the list is every link, newest first, with its expiry state", async () => {
    const links = tempLinks();
    seed(links, "first", "https://example.com/1");
    seed(links, "old", "https://example.com/2", new Date("2026-09-26T12:00:01Z"));
    seed(links, "third", "https://example.com/3", null, { madeBy: "kim" });
    const app = appWith(links, { now: () => new Date("2026-09-27T00:00:00Z") });
    const res = await apiCall(app, "GET", "/-/api/links");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      links: [
        { name: "third", url: "https://example.com/3", made_by: "kim", created_at: MADE.toISOString(), expires_at: null, expired: false },
        { name: "old", url: "https://example.com/2", made_by: "sam", created_at: MADE.toISOString(), expires_at: "2026-09-26T12:00:01.000Z", expired: true },
        { name: "first", url: "https://example.com/1", made_by: "sam", created_at: MADE.toISOString(), expires_at: null, expired: false },
      ],
    });
  });

  test("an empty store lists no links", async () => {
    const res = await apiCall(appWith(), "GET", "/-/api/links");
    expect([res.statusCode, res.json()]).toEqual([200, { links: [] }]);
  });

  test("one link is read by its name, in any case; an unknown or malformed name is a JSON 404", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    const app = appWith(links);
    const res = await apiCall(app, "GET", "/-/api/links/Q3-Plan");
    expect([res.statusCode, res.json().name, res.json().url]).toEqual([200, "q3-plan", "https://example.com/q3"]);
    for (const url of [
      "/-/api/links/nope",
      "/-/api/links/-x",
      "/-/api/links/a_b",
      "/-/api/links/q3%", // a malformed escape, which Fastify reports before routing
      `/-/api/links/${"x".repeat(101)}`, // past Fastify's maxParamLength
      `/-/api/links/${"x".repeat(101)}/counts`,
      "/-/api/nothing-here",
      "/-/API/nothing-here",
      "/%2D/api/nothing-here",
    ]) {
      const missing = await apiCall(app, "GET", url);
      expect([url, missing.statusCode, typeof missing.json().error]).toEqual([url, 404, "string"]);
    }
    const put = await app.inject({ method: "PUT", url: "/-/api/links/q3-plan" });
    expect([put.statusCode, typeof put.json().error]).toEqual([404, "string"]);
  });

  test("API answers are not cached", async () => {
    const res = await apiCall(appWith(), "GET", "/-/api/links");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("an API failure is logged as its route and status only (ADR-0004)", () => {
  test("a store that throws answers a JSON 500 and logs one line without the error", async () => {
    const links = tempLinks();
    links.list = () => {
      throw new Error("SQLITE_CORRUPT canary-7f3a");
    };
    const app = appWith(links);
    const res = await apiCall(app, "GET", "/-/api/links?who=203.0.113.9");
    expect([res.statusCode, res.json()]).toEqual([500, { error: "Something went wrong." }]);
    expect(app.logged).toEqual(["linkling: GET /-/api/links answered 500"]);
  });
});
