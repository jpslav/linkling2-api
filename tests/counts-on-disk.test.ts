// ADR-0014: a click touches no file, so neither the order of clicks nor the time of one can
// be read off the disk; the day's counts are written once, after the day, in one go.
import { existsSync, readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { msUntilFlush, startService, type Running } from "../src/server.js";
import { apiCall, appWith, countRows, seed, tempLinks } from "./support/app.js";
import { bearer, TEST_KEY } from "./support/team-key.js";
import { tempDir } from "./temp-db.js";

interface FileState {
  file: string;
  mtimeMs: number;
  bytes: string;
}

/** The database file and everything SQLite keeps beside it, as they are on disk now. */
function onDisk(dbPath: string): FileState[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
    .filter((file) => existsSync(file))
    .map((file) => ({ file, mtimeMs: statSync(file).mtimeMs, bytes: readFileSync(file).toString("base64") }));
}

describe("ADR-0014 counts on disk", () => {
  test("following links changes no byte and no modification time of any database file", async () => {
    const links = tempLinks();
    seed(links, "live", "https://example.com/live");
    seed(links, "old", "https://example.com/old", new Date("2026-09-26T12:30:00Z"));
    const app = appWith(links, { now: () => new Date("2026-09-26T13:00:00Z") });
    const dbPath = links.db.name;
    const before = onDisk(dbPath);
    expect(before.length, "blind: no database file to watch").toBeGreaterThan(0);

    // Long enough that a write would show in any file system's modification times.
    await sleep(50);
    for (let i = 0; i < 20; i++) {
      for (const [method, url] of [["GET", "/live"], ["HEAD", "/live"], ["GET", "/old"], ["GET", "/nope"]] as const) {
        await app.inject({ method, url });
      }
    }
    expect(onDisk(dbPath)).toEqual(before);
    // The follows were counted all the same, and the team sees them before they are written.
    expect((await apiCall(app, "GET", "/-/api/links/live/counts")).json().total).toBe(20);

    // Blind arm: the watch does see a write, which is the day's one.
    await sleep(50);
    expect(links.flushCounts()).toBe(20);
    expect(onDisk(dbPath)).not.toEqual(before);
  });

  test("the day's follows are written in one go, and the WAL is left empty", async () => {
    const links = tempLinks();
    const a = seed(links, "a", "https://example.com/a");
    const b = seed(links, "b", "https://example.com/b");
    let now = new Date("2026-09-26T09:00:00Z");
    const app = appWith(links, { now: () => now });
    for (const url of ["/a", "/b", "/a", "/b", "/b"]) await app.inject({ method: "GET", url });
    now = new Date("2026-09-27T00:00:01Z");
    await app.inject({ method: "GET", url: "/a" });

    expect(countRows(links)).toEqual([
      { link_id: a.id, day: "2026-09-26", count: 2 },
      { link_id: a.id, day: "2026-09-27", count: 1 },
      { link_id: b.id, day: "2026-09-26", count: 3 },
    ]);
    expect(statSync(`${links.db.name}-wal`).size, "the WAL keeps no copy of the write").toBe(0);
    // A second write adds to what is there rather than replacing it.
    await app.inject({ method: "GET", url: "/a" });
    expect(links.flushCounts()).toBe(1);
    expect(countRows(links).find((r) => r.link_id === a.id && r.day === "2026-09-27")?.count).toBe(2);
    expect(links.flushCounts(), "nothing is written when nothing was followed").toBe(0);
  });

  test("a write that fails keeps the day's follows for the next one", async () => {
    const links = tempLinks();
    const link = seed(links, "a", "https://example.com/a");
    const app = appWith(links, { now: () => new Date("2026-09-26T09:00:00Z") });
    await app.inject({ method: "GET", url: "/a" });
    links.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON daily_counts BEGIN SELECT RAISE(ABORT, 'full'); END");
    expect(() => links.flushCounts()).toThrow("full");
    links.db.exec("DROP TRIGGER refuse");
    expect(countRows(links)).toEqual([{ link_id: link.id, day: "2026-09-26", count: 1 }]);
  });

  test("the write is scheduled five seconds after each UTC midnight", () => {
    expect(msUntilFlush(new Date("2026-09-26T23:59:59Z"))).toBe(6_000);
    expect(msUntilFlush(new Date("2026-09-26T12:00:00Z"))).toBe(12 * 3_600_000 + 5_000);
    expect(msUntilFlush(new Date("2026-09-27T00:00:05Z"))).toBe(86_400_000);
    expect(msUntilFlush(new Date("2026-12-31T23:59:55Z"))).toBe(10_000);
  });
});

describe("the running service writes the day's follows when it stops", () => {
  const started: Running[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((s) => s.close()));
  });

  test("follows made before a stop are on disk after it, and counted after a restart", async () => {
    const data = tempDir();
    const env = { LINKLING_KEY: TEST_KEY, LINKLING_DATA: data, PORT: "0" };
    const first = (await startService(env, () => {}))!;
    const base = `http://127.0.0.1:${(first.app.server.address() as AddressInfo).port}`;
    await fetch(`${base}/-/api/links`, {
      method: "POST",
      headers: { ...bearer(TEST_KEY), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/kept", name: "kept" }),
    });
    for (let i = 0; i < 3; i++) await fetch(`${base}/kept`, { redirect: "manual" });
    await first.close();

    const dbPath = join(data, "linkling.db");
    expect(onDisk(dbPath).map((f) => f.file)).toEqual([dbPath]);

    const second = (await startService(env, () => {}))!;
    started.push(second);
    const port = (second.app.server.address() as AddressInfo).port;
    const counts = await fetch(`http://127.0.0.1:${port}/-/api/links/kept/counts`, { headers: bearer(TEST_KEY) });
    expect(((await counts.json()) as { total: number }).total).toBe(3);
  });
});
