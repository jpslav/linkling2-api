import * as crypto from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { MADE_UP_ALPHABET, claimMadeUpName, makeUpName } from "../src/names.js";
import { apiCall, appWith, seed, tempLinks } from "./support/app.js";

/** A set of taken names with the shape `claimMadeUpName` expects of an insert. */
class TakenNames {
  readonly names = new Set<string>();
  claim(name: string): boolean {
    if (this.names.has(name)) return false;
    this.names.add(name);
    return true;
  }
}

// Wraps the real randomInt so a test can see that it, and nothing weaker, is the source.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, randomInt: vi.fn(real.randomInt) };
});

// R-002's own pattern, typed out rather than built from MADE_UP_ALPHABET.
const MADE_UP = /^[a-hjkmnp-z2-9]{6}$/;

describe("R-002 made-up names", () => {
  test("R-002: 10,000 links made through the service with no name match ^[a-hjkmnp-z2-9]{6}$ and none repeat", async () => {
    const links = tempLinks();
    let clashes = 0;
    const tryCreate = links.tryCreate.bind(links);
    links.tryCreate = (link, now) => {
      const made = tryCreate(link, now);
      if (made === null) clashes++;
      return made;
    };
    const app = appWith(links);
    const names: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const res = await apiCall(app, "POST", "/-/api/links", { url: `https://example.com/${i}` });
      expect(res.statusCode).toBe(201);
      names.push(res.json().name);
    }
    expect(names).toHaveLength(10_000);
    expect(links.list()).toHaveLength(10_000);
    expect(names.filter((name) => !MADE_UP.test(name))).toEqual([]);
    expect(new Set(names).size).toBe(10_000);
    // The store makes the names distinct; the generator has to make clashes rare. Among
    // 10,000 uniform draws from 31^6 the expected number is about 0.056, so more than 3
    // happens by chance about once in 2.5 million runs.
    expect(clashes).toBeLessThanOrEqual(3);
  }, 120_000);

  test("R-002: the service retries a made-up name that is already taken", async () => {
    // Index 0 is `a` and 1 is `b`: the first six draws spell `aaaaaa`, the next six `bbbbbb`.
    const draws = [...Array<number>(6).fill(0), ...Array<number>(6).fill(1)];
    const links = tempLinks();
    seed(links, "aaaaaa", "https://example.com/taken");
    const app = appWith(links, { randomIndex: () => draws.shift() ?? 2 });
    const res = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/new" });
    expect([res.statusCode, res.json().name]).toEqual([201, "bbbbbb"]);
    expect(links.get("aaaaaa")?.target).toBe("https://example.com/taken");
  });

  test("R-002: made-up names come from node:crypto randomInt", () => {
    const randomInt = vi.mocked(crypto.randomInt);
    randomInt.mockClear();
    makeUpName();
    expect(randomInt).toHaveBeenCalledTimes(6);
    expect(randomInt.mock.calls.every(([max]) => max === 31)).toBe(true);
  });

  test("R-002: every letter is about equally likely", () => {
    const counts = new Map<string, number>();
    const draws = 31 * 2_000;
    for (let i = 0; i < draws / 6; i++) {
      for (const c of makeUpName()) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    // Chi-squared over 31 letters (30 degrees of freedom); a fair source exceeds 80 about
    // once in 500,000 runs (P ≈ 2.0e-6).
    const expected = (Math.floor(draws / 6) * 6) / 31;
    let chi2 = 0;
    for (const c of MADE_UP_ALPHABET) chi2 += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    expect(chi2).toBeLessThan(80);
  });

  test("R-002: a clash is retried with a fresh name", async () => {
    // Index 0 is `a` and 1 is `b`: the first six draws spell `aaaaaa`, the next six `bbbbbb`.
    const draws = [...Array<number>(6).fill(0), ...Array<number>(6).fill(1)];
    const scripted = () => draws.shift() ?? 2;
    const store = new TakenNames();
    store.claim("aaaaaa");
    const tried: string[] = [];

    const name = await claimMadeUpName((candidate) => {
      tried.push(candidate);
      return store.claim(candidate);
    }, scripted);

    expect(tried).toEqual(["aaaaaa", "bbbbbb"]);
    expect(name).toBe("bbbbbb");
  });

  test("R-002: gives up after the attempt limit rather than looping", async () => {
    let tries = 0;
    await expect(
      claimMadeUpName(() => {
        tries++;
        return false;
      }),
    ).rejects.toThrow("no free made-up name after 10 attempts");
    expect(tries).toBe(10);
  });

  test("R-002: only the 31-letter alphabet ever appears, and every letter of it does", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) for (const c of makeUpName()) seen.add(c);
    expect([...seen].sort().join("")).toBe([...MADE_UP_ALPHABET].sort().join(""));
    for (const confusable of "0o1li") expect(seen.has(confusable)).toBe(false);
  });
});
