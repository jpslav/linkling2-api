// The service refuses to start without the team key (ADR-0005).
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { main, refusal, type StartIo } from "../src/server.js";
import { MemoryLinks } from "./support/memory-links.js";
import { TEST_KEY } from "./support/team-key.js";

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
      return new MemoryLinks();
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

  test("refuses a key that could not be sent as Bearer: spaces, line breaks, non-ASCII", async () => {
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
});
