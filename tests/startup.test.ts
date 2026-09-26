// The service refuses to start without the team key (ADR-0005).
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, refusal, startService, type StartIo } from "../src/server.js";
import { tempLinks } from "./support/app.js";
import { bearer, TEST_KEY } from "./support/team-key.js";
import { tempDir } from "./temp-db.js";

const started: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.close()));
});

function io() {
  const said: string[] = [];
  const opened = { count: 0 };
  const start: StartIo = {
    stderr: (line) => said.push(line),
    openLinks: () => {
      opened.count++;
      return tempLinks();
    },
    listen: { port: 0, host: "127.0.0.1" },
  };
  return { start, said, opened };
}

describe("startup", () => {
  test("refuses to start without LINKLING_KEY, before it opens the store", async () => {
    for (const env of [{}, { LINKLING_KEY: "" }]) {
      const { start, said, opened } = io();
      expect(await main(env, start)).toBeNull();
      expect(said).toEqual([refusal("is not set")]);
      expect(opened.count).toBe(0);
    }
  });

  test("refuses a key that is not printable ASCII without spaces", async () => {
    for (const key of ["   ", `${TEST_KEY}\n`, ` ${TEST_KEY}`, "two words", "clé-secrète"]) {
      const { start, said, opened } = io();
      expect(await main({ LINKLING_KEY: key }, start)).toBeNull();
      expect(said).toEqual([refusal("must be printable ASCII with no spaces or line breaks")]);
      expect(opened.count).toBe(0);
    }
  });

  test("starts with a key, and the service answers on the port it took", async () => {
    const { start, said, opened } = io();
    const app = await main({ LINKLING_KEY: TEST_KEY }, start);
    expect(app).not.toBeNull();
    started.push(app!);
    expect([said, opened.count]).toEqual([[], 1]);
    const { port } = app!.server.address() as AddressInfo;
    const health = await fetch(`http://127.0.0.1:${port}/-/health`);
    expect([health.status, await health.text()]).toEqual([200, "ok\n"]);
  });

  test("refuses a LINKLING_SITE that is not an http or https address, before it opens the store", async () => {
    for (const site of ["linkling.example.org", "ftp://linkling.example.org", "javascript:alert(1)", "https://x.example/?a=1", "https://x.example/?", "https://x.example/#top", "https://x.example/a#", "https://x.example ", " https://x.example", "https://x.example/a\tb", "https://u:p@x.example"]) {
      const { start, said, opened } = io();
      expect(await main({ LINKLING_KEY: TEST_KEY, LINKLING_SITE: site }, start)).toBeNull();
      expect(said).toEqual([
        "linkling: LINKLING_SITE must be the public site's http or https address, such as https://linkling.example.org; the service will not start with it set like this.",
      ]);
      expect(opened.count).toBe(0);
    }
  });

  test("links the stats page's Privacy to LINKLING_SITE when set, and starts without it when empty", async () => {
    for (const [site, privacy] of [
      ["https://linkling.example.org/about/", "https://linkling.example.org/about/privacy.html"],
      ["", "https://github.com/jpslav/linkling2-web/blob/main/privacy.html"],
    ] as const) {
      const { start, said } = io();
      const app = await main({ LINKLING_KEY: TEST_KEY, LINKLING_SITE: site }, start);
      expect([app === null, said]).toEqual([false, []]);
      started.push(app!);
      const page = await app!.inject({ method: "GET", url: "/-/stats", headers: bearer(TEST_KEY) });
      expect(page.body).toContain(`<a href="${privacy}">Privacy</a>`);
    }
  });
});

// The direct run: what `node dist/server.js` does with its environment.
describe("startService", () => {
  test("opens the database in LINKLING_DATA, serves on PORT, and keeps links across a restart", async () => {
    const data = tempDir();
    const env = { LINKLING_KEY: TEST_KEY, LINKLING_DATA: data, PORT: "0" };
    const said: string[] = [];

    const first = await startService(env, (line) => said.push(line));
    expect(first).not.toBeNull();
    started.push(first!);
    expect(existsSync(join(data, "linkling.db"))).toBe(true);
    const base = `http://127.0.0.1:${(first!.app.server.address() as AddressInfo).port}`;
    const made = await fetch(`${base}/-/api/links`, {
      method: "POST",
      headers: { ...bearer(TEST_KEY), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/kept", name: "kept" }),
    });
    expect(made.status).toBe(201);
    await first!.close();
    started.splice(started.indexOf(first!), 1);

    const second = await startService(env, (line) => said.push(line));
    expect(second).not.toBeNull();
    started.push(second!);
    const port = (second!.app.server.address() as AddressInfo).port;
    const follow = await fetch(`http://127.0.0.1:${port}/kept`, { redirect: "manual" });
    expect([follow.status, follow.headers.get("location")]).toEqual([302, "https://example.com/kept"]);
    expect(said).toEqual([]);
  });

  test("a data directory that cannot hold the database stops start-up with the reason", async () => {
    const notADir = join(tempDir(), "a-file");
    writeFileSync(notADir, "");
    const said: string[] = [];
    expect(await startService({ LINKLING_KEY: TEST_KEY, LINKLING_DATA: notADir, PORT: "0" }, (line) => said.push(line))).toBeNull();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^linkling: could not open the database in .*a-file: /);
  });

  test("a PORT that is not a port number stops start-up before anything opens", async () => {
    const data = tempDir();
    for (const port of ["http", "-1", "65536", "80.5", ""]) {
      const said: string[] = [];
      expect(await startService({ LINKLING_KEY: TEST_KEY, LINKLING_DATA: data, PORT: port }, (line) => said.push(line))).toBeNull();
      expect(said).toEqual([`linkling: PORT must be a port number from 0 to 65535, not "${port}".`]);
    }
    expect(existsSync(join(data, "linkling.db"))).toBe(false);
  });

  test("still refuses to start without the key", async () => {
    const said: string[] = [];
    expect(await startService({ LINKLING_DATA: tempDir(), PORT: "0" }, (line) => said.push(line))).toBeNull();
    expect(said).toEqual([refusal("is not set")]);
  });
});
