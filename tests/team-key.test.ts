// Only someone with the team key can make, delete or list links, or see the stats (R-014),
// and the key is one shared secret sent as Bearer or as the Basic password (ADR-0005).
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryLinks } from "./support/memory-links.js";
import { basic, bearer, TEST_KEY } from "./support/team-key.js";

const CHALLENGE = 'Basic realm="Linkling", charset="UTF-8"';

/**
 * The app with stand-ins at the two paths R-014's verify line calls, registered after
 * buildApp returns, the way the routes that serve them will be. `ran` counts handler runs.
 */
function guarded() {
  const app = buildApp({ links: new MemoryLinks(), key: TEST_KEY });
  const ran = { count: 0 };
  app.get("/-/api/links", async () => {
    ran.count++;
    return "the links";
  });
  app.get("/-/stats", async () => {
    ran.count++;
    return "the stats";
  });
  return { app, ran };
}

function expectRefused(res: LightMyRequestResponse): void {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe(CHALLENGE);
  expect(res.headers["set-cookie"]).toBeUndefined();
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toBe("The team key is needed.\n");
}

describe("R-014 the team key", () => {
  test("R-014: listing links and the stats page are refused without the key", async () => {
    const { app, ran } = guarded();
    for (const url of ["/-/api/links", "/-/stats"]) {
      expectRefused(await app.inject({ method: "GET", url }));
    }
    expect(ran.count).toBe(0);
  });

  test("R-014: a wrong key is refused, as Bearer and as the Basic password", async () => {
    const { app, ran } = guarded();
    const wrong = [
      bearer("not-the-key"),
      bearer(TEST_KEY.slice(0, -1)),
      bearer(`${TEST_KEY}x`),
      basic("ana", "not-the-key"),
      basic(TEST_KEY, ""),
      { authorization: `Basic ${Buffer.from(TEST_KEY).toString("base64")}` },
      { authorization: `Token ${TEST_KEY}` },
      { authorization: TEST_KEY },
      { authorization: "Bearer" },
    ];
    for (const headers of wrong) {
      expectRefused(await app.inject({ method: "GET", url: "/-/api/links", headers }));
    }
    expect(ran.count).toBe(0);
  });

  test("R-014: the key is accepted as Bearer, and as the Basic password with any user name", async () => {
    const { app, ran } = guarded();
    const right = [
      bearer(TEST_KEY),
      { authorization: `bearer ${TEST_KEY}` },
      basic("ana", TEST_KEY),
      basic("", TEST_KEY),
    ];
    for (const headers of right) {
      const res = await app.inject({ method: "GET", url: "/-/stats", headers });
      expect([res.statusCode, res.body]).toEqual([200, "the stats"]);
    }
    expect(ran.count).toBe(right.length);
  });

  test("R-014: a Basic password holding a colon is the whole key", async () => {
    const app = buildApp({ links: new MemoryLinks(), key: "a:b" });
    app.get("/-/stats", async () => "the stats");
    const res = await app.inject({ method: "GET", url: "/-/stats", headers: basic("ana", "a:b") });
    expect(res.statusCode).toBe(200);
  });

  test("R-014: an encoded path that routes to a guarded route is still refused", async () => {
    const { app, ran } = guarded();
    for (const url of ["/%2D/api/links", "/%2d/stats", "/-/api/li%6Eks", "/-/x/../stats", "/-/stats/"]) {
      expectRefused(await app.inject({ method: "GET", url }));
    }
    expect(ran.count).toBe(0);
  });

  test("R-014: a route added later, inside a prefixed plugin, is guarded too", async () => {
    const app = buildApp({ links: new MemoryLinks(), key: TEST_KEY });
    await app.register(
      async (api) => {
        api.delete("/links/:name", async () => "deleted");
      },
      { prefix: "/-/api" },
    );
    expectRefused(await app.inject({ method: "DELETE", url: "/-/api/links/q3-plan" }));
    const res = await app.inject({ method: "DELETE", url: "/-/api/links/q3-plan", headers: bearer(TEST_KEY) });
    expect([res.statusCode, res.body]).toEqual([200, "deleted"]);
  });

  test("R-014: only /-/health itself is open, not routes that start like it", async () => {
    const { app } = guarded();
    app.get("/-/healthz", async () => "no");
    app.get("/-/health/details", async () => "no");
    for (const url of ["/-/healthz", "/-/health/details"]) {
      expectRefused(await app.inject({ method: "GET", url }));
    }
  });

  test("R-014: HEAD on a guarded route is refused too", async () => {
    const { app, ran } = guarded();
    const res = await app.inject({ method: "HEAD", url: "/-/stats" });
    expect([res.statusCode, res.headers["www-authenticate"]]).toEqual([401, CHALLENGE]);
    expect(ran.count).toBe(0);
  });

  test("health answers without the key and says nothing else", async () => {
    const { app } = guarded();
    const res = await app.inject({ method: "GET", url: "/-/health" });
    expect([res.statusCode, res.body]).toEqual([200, "ok\n"]);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  test("an app cannot be built without a usable key", () => {
    for (const key of ["", "   ", `${TEST_KEY}\n`]) {
      expect(() => buildApp({ links: new MemoryLinks(), key })).toThrow("an app cannot be built without a usable one");
    }
  });
});
