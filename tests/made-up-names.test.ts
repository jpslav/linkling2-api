import { describe, expect, test } from "vitest";
import { MADE_UP_ALPHABET, claimMadeUpName, makeUpName } from "../src/names.js";
import { MemoryLinks } from "./support/memory-links.js";

// R-002's own pattern, typed out rather than built from MADE_UP_ALPHABET.
const MADE_UP = /^[a-hjkmnp-z2-9]{6}$/;

describe("R-002 made-up names", () => {
  test("R-002: 10,000 made-up names match ^[a-hjkmnp-z2-9]{6}$ and none repeat", async () => {
    const store = new MemoryLinks();
    const names: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      names.push(await claimMadeUpName((name) => store.claim(name)));
    }
    expect(names).toHaveLength(10_000);
    expect(names.filter((name) => !MADE_UP.test(name))).toEqual([]);
    expect(new Set(names).size).toBe(10_000);
  });

  test("R-002: a clash is retried with a fresh name", async () => {
    // Index 0 is `a` and 1 is `b`: the first six draws spell `aaaaaa`, the next six `bbbbbb`.
    const draws = [...Array<number>(6).fill(0), ...Array<number>(6).fill(1)];
    const scripted = () => draws.shift() ?? 2;
    const store = new MemoryLinks().make("aaaaaa", "https://example.com/taken");
    const tried: string[] = [];

    const name = await claimMadeUpName((candidate) => {
      tried.push(candidate);
      return store.claim(candidate);
    }, scripted);

    expect(tried).toEqual(["aaaaaa", "bbbbbb"]);
    expect(name).toBe("bbbbbb");
    expect(store.links.get("aaaaaa")?.target).toBe("https://example.com/taken");
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
