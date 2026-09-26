// The stats page (R-010 to R-014, ADR-0015). The verify lines select these tests by name with
// -t 'filter', 'expired row' and 'footer'; keep those phrases in the names.
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterEach, describe, expect, test } from "vitest";
import { utcDay } from "../src/db/links.js";
import { DAYS, PRIVACY_FALLBACK, sparkline } from "../src/stats.js";
import type { SqliteLinks } from "../src/store.js";
import { appWith, seed, tempLinks } from "./support/app.js";
import { basic, bearer, TEST_KEY } from "./support/team-key.js";

const NOW = new Date("2026-09-26T15:00:00Z");
const DAY_MS = 86_400_000;
const daysAgo = (n: number): string => utcDay(new Date(NOW.getTime() - n * DAY_MS));

/** Writes `count` follows for a link on the day `n` days before NOW, straight into the table. */
function counted(links: SqliteLinks, id: number, n: number, count: number): void {
  links.db.prepare("INSERT INTO daily_counts (link_id, day, count) VALUES (?, ?, ?)").run(id, daysAgo(n), count);
}

type App = ReturnType<typeof appWith>;

function statsOf(app: App, headers: Record<string, string> = basic("", TEST_KEY)) {
  return app.inject({ method: "GET", url: "/-/stats", headers });
}

/** Each link row's cells, as text, in page order. */
function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr class="link[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell!),
  );
}
const namesOf = (html: string): string[] => rowsOf(html).map((cells) => cells[0]!);

describe("R-010 the stats page lists every link", () => {
  test("R-010 busiest first with all seven columns", async () => {
    const links = tempLinks();
    // quiet: busier in all but the last 14 days; loud: the busiest recently.
    const quiet = seed(links, "quiet", "https://example.com/quiet", null, { madeBy: "ana" });
    const loud = seed(links, "loud", "https://example.com/loud", null, { madeBy: "ben" });
    // tie-a and tie-b: the same 14 days, told apart by their totals.
    const tieA = seed(links, "tie-a", "https://example.com/a");
    const tieB = seed(links, "tie-b", "https://example.com/b", null, { madeBy: "" });
    counted(links, quiet.id, DAYS, 500); // just outside the window
    counted(links, quiet.id, DAYS - 1, 2); // the window's first day
    counted(links, loud.id, 3, 9);
    counted(links, tieA.id, 5, 4);
    counted(links, tieB.id, 5, 4);
    counted(links, tieB.id, 30, 1);
    const app = appWith(links, { now: () => NOW });
    // Followed today and not yet written to disk: still on the page (ADR-0014).
    for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: "/loud" });

    const res = await statsOf(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["set-cookie"]).toBeUndefined();
    const html = res.body;
    expect(html).toContain("<h1>Linkling — our links</h1>");
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(([, th]) => th)).toEqual([
      "Short link", "Goes to", "Made by", "Expires", `Last ${DAYS} days`, "Total",
    ]);
    expect(html).toContain('<th colspan="2" scope="colgroup">Short link</th>');

    expect(namesOf(html)).toEqual(["loud", "tie-b", "tie-a", "quiet"]);
    const rows = rowsOf(html);
    for (const cells of rows) expect(cells).toHaveLength(7);
    const [loudRow, tieBRow, , quietRow] = rows;
    expect(loudRow![1]).toMatch(/<button type="button" class="copy" data-name="loud">Copy<\/button>/);
    expect(loudRow!.slice(2, 5)).toEqual(["https://example.com/loud", "ben", "never"]);
    expect(loudRow![5]).toContain("oldest first: 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 3");
    expect(loudRow![6]).toBe("12");
    expect(tieBRow![3]).toBe("—");
    expect(tieBRow![6]).toBe("5");
    expect(quietRow![5]).toContain("oldest first: 2, 0,");
    expect(quietRow![6]).toBe("502");
    expect(app.logged).toEqual([]);
  });

  test("an expiry shows as a UTC date, or a date and minute when it is not the end of a day", async () => {
    const links = tempLinks();
    seed(links, "dated", "https://example.com/d", new Date("2026-10-03T23:59:59.999Z"));
    seed(links, "timed", "https://example.com/t", new Date("2026-09-27T09:30:00Z"));
    const rows = rowsOf((await statsOf(appWith(links, { now: () => NOW }))).body);
    expect(rows.map((cells) => [cells[0], cells[4]])).toEqual([
      ["dated", "2026-10-03"],
      ["timed", "2026-09-27 09:30 UTC"],
    ]);
  });

  test("the 14-day line runs oldest to newest, left to right, higher for busier days", () => {
    const pointsOf = (svg: string) =>
      /points="([^"]*)"/.exec(svg)![1]!.split(" ").map((xy) => xy.split(",").map(Number));
    const line = pointsOf(sparkline([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 10]));
    expect(line).toHaveLength(14);
    expect(line.map(([x]) => x)[0]).toBe(0);
    expect(line.map(([x]) => x)[13]).toBe(130);
    // SVG y grows downward: the busiest day is at the top, a zero at the bottom.
    expect([line[0]![1], line[12]![1], line[13]![1]]).toEqual([22, 12, 2]);
    expect(pointsOf(sparkline(Array(14).fill(0))).map(([, y]) => y)).toEqual(Array(14).fill(22));
  });

  test("names, targets and makers are shown as text, never as markup", async () => {
    const links = tempLinks();
    seed(links, "x", 'https://example.com/?q="><script>alert(1)</script>', null, { madeBy: "<img src=x onerror=alert(2)>" });
    const html = (await statsOf(appWith(links, { now: () => NOW }))).body;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain('data-target="https://example.com/?q=&quot;&gt;&lt;script&gt;');
  });

  test("with no links it says so and points at how to make one", async () => {
    const html = (await statsOf(appWith(tempLinks(), { now: () => NOW }))).body;
    expect(rowsOf(html)).toEqual([]);
    expect(html).toContain('No links yet. <a href="#make-a-link">');
  });

  test("the page loads nothing but its own stylesheet and script", async () => {
    const app = appWith(tempLinks(), { now: () => NOW });
    const res = await statsOf(app);
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect([...res.body.matchAll(/\b(?:src|href)="([^"#][^"]*)"/g)].map(([, url]) => url)).toEqual([
      "/-/stats.css",
      "/-/stats.js",
      PRIVACY_FALLBACK,
      "https://github.com/jpslav/linkling2-api#readme",
      PRIVACY_FALLBACK,
    ]);
    for (const [url, type] of [["/-/stats.css", "text/css"], ["/-/stats.js", "text/javascript"]] as const) {
      const asset = await app.inject({ method: "GET", url, headers: basic("", TEST_KEY) });
      expect([asset.statusCode, asset.headers["content-type"]]).toEqual([200, `${type}; charset=utf-8`]);
    }
    expect(app.logged).toEqual([]);
  });
});

describe("R-014 the stats page needs the team key", () => {
  test("without the key, or with a wrong one, the page and its files answer 401 and show no link", async () => {
    const links = tempLinks();
    seed(links, "secret-plan", "https://example.com/secret");
    const app = appWith(links, { now: () => NOW });
    for (const url of ["/-/stats", "/-/stats.css", "/-/stats.js"]) {
      for (const headers of [{}, basic("", "wrong-key"), bearer("wrong-key")]) {
        const res = await app.inject({ method: "GET", url, headers });
        expect(res.statusCode).toBe(401);
        expect(res.headers["www-authenticate"]).toBe('Basic realm="Linkling", charset="UTF-8"');
        expect(res.body).not.toContain("secret");
      }
    }
    // Any user name, or none, with the key as the password (ADR-0005).
    expect((await statsOf(app, basic("ana", TEST_KEY))).statusCode).toBe(200);
  });
});

describe("R-012 expired links", () => {
  test("R-012 an expired row stays, greyed, marked expired, with its total", async () => {
    const links = tempLinks();
    const old = seed(links, "old-deck", "https://slides.example.com/deck-v2", new Date("2026-09-20T23:59:59.999Z"), { madeBy: "cy" });
    seed(links, "live", "https://example.com/live");
    counted(links, old.id, 20, 7);
    const html = (await statsOf(appWith(links, { now: () => NOW }))).body;
    expect(html).toMatch(/<tr class="link expired" data-name="old-deck"/);
    expect(html).toMatch(/<tr class="link" data-name="live"/);
    const row = rowsOf(html).find((cells) => cells[0] === "old-deck")!;
    expect(row[4]).toBe('<span class="gone">expired</span>');
    expect(row[6]).toBe("7");
  });
});

describe("R-013 footer", () => {
  const footerOf = (html: string) => /<footer>([\s\S]*?)<\/footer>/.exec(html)![1]!;

  test("R-013 footer links to the public site's privacy page and to how to make a link", async () => {
    const withSite = footerOf((await statsOf(appWith(tempLinks(), { now: () => NOW, site: "https://linkling.example.org/" }))).body);
    expect(withSite).toBe('<a href="https://linkling.example.org/privacy.html">Privacy</a> · <a href="#make-a-link">Make a link (CLI)</a>');
    const html = (await statsOf(appWith(tempLinks(), { now: () => NOW }))).body;
    expect(footerOf(html)).toContain(`<a href="${PRIVACY_FALLBACK}">Privacy</a>`);
    // The CLI link lands on a section that shows the command.
    expect(html).toMatch(/<section id="make-a-link">[\s\S]*<code>linkling make https:\/\/[^<]* --name q3-plan<\/code>/);
  });
});

describe("R-011 filter, in a real browser", () => {
  const closers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  /**
   * The page, with the app listening on a real port, in headless Chromium holding the key.
   * `host` is the name the browser uses: 127.0.0.1 is a secure context, and `linkling.test`,
   * resolved to it here, is plain http on a LAN-style name, which is not.
   */
  async function openPage(links: SqliteLinks, host = "127.0.0.1") {
    const app = appWith(links, { now: () => NOW });
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP linkling.test 127.0.0.1"] });
    closers.push(() => browser.close());
    const context = await browser.newContext({ httpCredentials: { username: "", password: TEST_KEY } });
    const page = await context.newPage();
    const loaded: string[] = [];
    page.on("requestfinished", (request) => loaded.push(new URL(request.url()).pathname));
    const { port } = app.server.address() as AddressInfo;
    await page.goto(`http://${host}:${port}/-/stats`);
    return { page, loaded, port };
  }

  const visibleNames = (page: import("playwright").Page) =>
    page.locator("tr.link:visible td.name").allTextContents();

  test("R-011 filter narrows the list as you type, by short name or target", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://docs.example.com/Q3-planning-final");
    seed(links, "offsite", "https://calendar.example.com/event?id=88");
    seed(links, "board", "https://example.com/decks/q3");
    seed(links, "hjkm4t", "https://github.com/example/repo/pull/12");
    const { page, loaded } = await openPage(links);
    // The script and stylesheet came through the key-guarded routes, or nothing below works.
    expect(loaded.sort()).toEqual(["/-/stats", "/-/stats.css", "/-/stats.js"]);
    expect((await visibleNames(page)).sort()).toEqual(["board", "hjkm4t", "offsite", "q3-plan"]);

    await page.locator("#filter").pressSequentially("q3");
    expect((await visibleNames(page)).sort()).toEqual(["board", "q3-plan"]);
    await expect.poll(() => page.locator("#no-match").isVisible()).toBe(false);

    // Only the target holds this, and only the short name holds the next two.
    await page.locator("#filter").fill("CALENDAR");
    expect(await visibleNames(page)).toEqual(["offsite"]);
    await page.locator("#filter").fill("hjkm");
    expect(await visibleNames(page)).toEqual(["hjkm4t"]);
    await page.locator("#filter").fill("BOARD");
    expect(await visibleNames(page)).toEqual(["board"]);

    await page.locator("#filter").fill("nothing-like-this");
    expect(await visibleNames(page)).toEqual([]);
    expect(await page.locator("#no-match").isVisible()).toBe(true);

    await page.locator("#filter").fill("");
    expect(await visibleNames(page)).toHaveLength(4);
  }, 30_000);

  test("Copy puts the short link, as this browser reaches the service, on the clipboard", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://docs.example.com/q3");
    const { page, port } = await openPage(links);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${port}` });
    await page.locator("button.copy").click();
    await expect.poll(() => page.locator("button.copy").textContent()).toBe("Copied");
    expect(await page.evaluate("navigator.clipboard.readText()")).toBe(`http://127.0.0.1:${port}/q3-plan`);
  }, 30_000);

  test("Copy works over plain http on a LAN name too, where the Clipboard API is missing", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://docs.example.com/q3");
    const { page, port } = await openPage(links, "linkling.test");
    expect(await page.evaluate("[window.isSecureContext, typeof navigator.clipboard]")).toEqual([false, "undefined"]);
    await page.locator("button.copy").click();
    await expect.poll(() => page.locator("button.copy").textContent()).toBe("Copied");
    // Read back from a secure page in the same browser, which can reach the clipboard.
    const reader = await page.context().newPage();
    await reader.goto(`http://127.0.0.1:${port}/-/stats`);
    await page.context().grantPermissions(["clipboard-read"], { origin: `http://127.0.0.1:${port}` });
    expect(await reader.evaluate("navigator.clipboard.readText()")).toBe(`http://linkling.test:${port}/q3-plan`);
  }, 30_000);
});
