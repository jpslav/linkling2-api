// A link that has gone says so, rather than going anywhere (R-018), over the SQLite store.
import { describe, expect, test, vi } from "vitest";
import type { buildApp } from "../src/app.js";
import { MADE, appWith, seed, tempLinks } from "./support/app.js";

function expectPlainPage(
  res: Awaited<ReturnType<ReturnType<typeof buildApp>["inject"]>>,
  status: number,
  body: string,
) {
  expect(res.statusCode).toBe(status);
  expect(res.headers.location).toBeUndefined();
  expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
  expect(res.body).toBe(body);
}

describe("R-018 gone links", () => {
  test("R-018: a deleted and a never-made name answer 404 with a body and no Location", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/a");
    links.delete("q3-plan");
    const app = appWith(links, { now: () => MADE });
    expectPlainPage(await app.inject({ method: "GET", url: "/q3-plan" }), 404, "No such link.\n");
    expectPlainPage(await app.inject({ method: "GET", url: "/never-made" }), 404, "No such link.\n");
  });

  test("R-018: an expired link answers 410 with a body and no Location", async () => {
    const links = tempLinks();
    seed(links, "old", "https://example.com/a", new Date("2026-09-25T23:59:59Z"), { at: new Date("2026-09-25T12:00:00Z") });
    expectPlainPage(await appWith(links, { now: () => MADE }).inject({ method: "GET", url: "/old" }), 410, "This link has expired.\n");
  });

  test("a link expiring exactly now is expired; one a millisecond later is not", async () => {
    const links = tempLinks();
    seed(links, "now", "https://example.com/a", MADE);
    seed(links, "later", "https://example.com/b", new Date(MADE.getTime() + 1));
    const app = appWith(links, { now: () => MADE });
    expect((await app.inject({ method: "GET", url: "/now" })).statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: "/later" })).statusCode).toBe(302);
  });

  test("a link with no expiry still redirects a hundred years on", async () => {
    const links = tempLinks();
    seed(links, "forever", "https://example.com/a", null);
    const app = appWith(links, { now: () => new Date("2126-09-26T12:00:00Z") });
    expect((await app.inject({ method: "GET", url: "/forever" })).statusCode).toBe(302);
  });

  test("a name of the wrong shape answers the same 404 without a lookup", async () => {
    const links = tempLinks();
    const lookup = vi.spyOn(links, "lookup");
    const app = appWith(links);
    for (const url of [
      "/q3_plan",
      "/favicon.ico",
      `/${"x".repeat(65)}`,
      `/${"x".repeat(101)}`, // past Fastify's default maxParamLength, which answers a JSON 414
      `/${"x".repeat(5000)}`,
      "/%E2%84%AA",
      "/q3-plan%", // a malformed escape, which Fastify answers with a JSON 400 by default
      "/%zz",
    ]) {
      expectPlainPage(await app.inject({ method: "GET", url }), 404, "No such link.\n");
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  test("a store that fails answers a plain 500, and writes nothing to any log", async () => {
    const links = tempLinks();
    links.lookup = () => Promise.reject(new Error("SQLITE_BUSY at /data/linkling.db canary-9d1e"));
    const app = appWith(links);
    const res = await app.inject({
      method: "GET",
      url: "/q3-plan?who=203.0.113.9",
      headers: { "user-agent": "ClickerBrowser/1.0", referer: "https://chat.example/room" },
    });
    expectPlainPage(res, 500, "Something went wrong.\n");
    expect(app.logged).toEqual([]);
  });
});
