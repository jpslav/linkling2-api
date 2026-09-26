import { expect, test } from "vitest";
import { createLink, getLinkByName, type Link as StoredLink } from "../src/db/links.js";
import { isExpired } from "../src/links.js";
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
