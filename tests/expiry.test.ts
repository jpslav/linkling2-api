import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { createLink, getLinkByName, type Link as StoredLink } from "../src/db/links.js";
import { isExpired } from "../src/links.js";
import { MADE, apiCall, appWith } from "./support/app.js";
import { openTempDatabase } from "./temp-db.js";

const made = new Date("2026-09-26T12:00:00Z");
const in100Years = new Date("2126-09-26T12:00:00Z");

// The stored row, as the redirect's expiry rule (src/links.ts) sees it.
function asRedirectLink(link: StoredLink) {
  return { target: link.target, expiresAt: link.expiresAt === null ? null : new Date(link.expiresAt) };
}

// R-006, data-layer half: the redirect answering 100 years on is the route's (LL-007).
// The verify line selects this test with -t 'no expiry is forever', and a -t that
// matches nothing exits 0, so keep that phrase in the name.
test("a link made with no expiry is forever", () => {
  const db = openTempDatabase();
  createLink(db, { name: "q3-plan", target: "https://example.com/q3", madeBy: "sam", expiresAt: null }, made);

  const raw = db.prepare("SELECT expires_at FROM links WHERE name = ?").get("q3-plan") as { expires_at: unknown };
  expect(raw.expires_at).toBeNull();

  const link = getLinkByName(db, "q3-plan");
  expect(link).toBeDefined();
  expect(isExpired(asRedirectLink(link!), in100Years)).toBe(false);
});

test("a stored expiry round-trips to the millisecond the redirect's rule compares", () => {
  const db = openTempDatabase();
  const expiresAt = new Date("2026-10-01T23:59:59.999Z");
  const link = createLink(db, { name: "offsite", target: "https://example.com/o", madeBy: "sam", expiresAt }, made);

  expect(link.expiresAt).toBe("2026-10-01T23:59:59.999Z");
  const stored = asRedirectLink(getLinkByName(db, "offsite")!);
  expect(isExpired(stored, new Date("2026-10-01T23:59:59.998Z"))).toBe(false);
  expect(isExpired(stored, expiresAt)).toBe(true);
});

describe("R-005 and R-006 through the service", () => {
  // On the real clock, as R-005's verify line describes it.
  test("R-005: a link made to expire in two seconds redirects, and three seconds later answers 410", async () => {
    const app = appWith();
    const made = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/soon", name: "soon", expires: "2s" });
    expect(made.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/soon" })).statusCode).toBe(302);
    await sleep(3000);
    const later = await app.inject({ method: "GET", url: "/soon" });
    expect([later.statusCode, later.headers.location]).toEqual([410, undefined]);
    expect((await apiCall(app, "GET", "/-/api/links/soon")).json().expired).toBe(true);
  }, 10_000);

  test("R-005: an expiry given as a date is the end of that day in UTC", async () => {
    let now = MADE;
    const app = appWith(undefined, { now: () => now });
    const made = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/o", name: "offsite", expires: "2026-10-01" });
    expect(made.json().expires_at).toBe("2026-10-01T23:59:59.999Z");
    now = new Date("2026-10-01T23:59:59.998Z");
    expect((await app.inject({ method: "GET", url: "/offsite" })).statusCode).toBe(302);
    now = new Date("2026-10-01T23:59:59.999Z");
    expect((await app.inject({ method: "GET", url: "/offsite" })).statusCode).toBe(410);
  });

  test("R-005: a lifetime counts from when the link is made, in s, m, h or d", async () => {
    const app = appWith(undefined, { now: () => MADE });
    const cases: [string, number][] = [
      ["2s", 2_000],
      ["90m", 90 * 60_000],
      ["36h", 36 * 3_600_000],
      ["7d", 7 * 86_400_000],
    ];
    for (const [expires, ms] of cases) {
      const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/l", expires });
      expect([expires, res.json().expires_at]).toEqual([expires, new Date(MADE.getTime() + ms).toISOString()]);
    }
  });

  test("a date expiry of today is still allowed: it lasts until the end of the day", async () => {
    const app = appWith(undefined, { now: () => MADE });
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/t", expires: "2026-09-26" });
    expect([res.statusCode, res.json().expires_at]).toEqual([201, "2026-09-26T23:59:59.999Z"]);
  });

  // The verify line selects this with -t 'no expiry is forever'; keep that phrase in the name.
  test("R-006: a link made through the service with no expiry is forever", async () => {
    let now = MADE;
    const app = appWith(undefined, { now: () => now });
    const made = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/f", name: "forever" });
    expect(made.json().expires_at).toBeNull();
    now = new Date("2126-09-26T12:00:00Z");
    const follow = await app.inject({ method: "GET", url: "/forever" });
    expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/f"]);
    expect((await apiCall(app, "GET", "/-/api/links/forever")).json()).toMatchObject({ expires_at: null, expired: false });
  });

  test("an explicit null expiry is the same as none", async () => {
    const app = appWith(undefined, { now: () => MADE });
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/f", expires: null });
    expect([res.statusCode, res.json().expires_at]).toEqual([201, null]);
  });
});
