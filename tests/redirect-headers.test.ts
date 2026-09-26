// The redirect a short link answers with (ADR-0002), and the full header set it may carry
// (ADR-0009).
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryLinks } from "./support/memory-links.js";

// ADR-0009: every header a live redirect may carry. The first three are ADR-0002's;
// the rest are written by Node's HTTP server on every response.
const REDIRECT_HEADERS = [
  "cache-control",
  "connection",
  "content-length",
  "date",
  "keep-alive",
  "location",
  "referrer-policy",
];

const opened: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()));
});

interface Wire {
  statusLine: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Follows a path over a real socket, as curl would, and reports what came back. */
async function overTheWire(links: MemoryLinks, path: string): Promise<Wire> {
  const app = buildApp({ links });
  opened.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ statusLine: `HTTP/${res.httpVersion} ${res.statusCode}`, headers: res.headers }),
      );
    })
      .on("error", reject)
      .end();
  });
}

describe("R-019 uncached redirect", () => {
  test("R-019: a live link answers HTTP/1.1 302 with Cache-Control no-store", async () => {
    const wire = await overTheWire(new MemoryLinks().make("q3-plan", "https://example.com/a"), "/q3-plan");
    expect(wire.statusLine).toBe("HTTP/1.1 302");
    expect(wire.headers["cache-control"]).toBe("private, no-store");
    expect(wire.headers.location).toBe("https://example.com/a");
  });

  test("R-019: after delete, and after delete-and-remake, the next click gets the new answer", async () => {
    const links = new MemoryLinks().make("q3-plan", "https://example.com/old");
    const app = buildApp({ links });
    const click = () => app.inject({ method: "GET", url: "/q3-plan" });

    expect((await click()).headers.location).toBe("https://example.com/old");
    links.delete("q3-plan");
    const gone = await click();
    expect([gone.statusCode, gone.headers.location]).toEqual([404, undefined]);
    links.make("q3-plan", "https://example.com/new");
    const remade = await click();
    expect([remade.statusCode, remade.headers.location]).toEqual([302, "https://example.com/new"]);
  });

  test("ADR-0009: the redirect sends exactly the reviewed headers", async () => {
    const wire = await overTheWire(new MemoryLinks().make("q3-plan", "https://example.com/a"), "/q3-plan");
    // Fixed population first: a response with no headers at all must fail, not pass.
    expect(wire.headers.location).toBe("https://example.com/a");
    expect(Object.keys(wire.headers).sort()).toEqual(REDIRECT_HEADERS);
    expect(wire.headers["referrer-policy"]).toBe("no-referrer");
    expect(wire.headers["set-cookie"]).toBeUndefined();
  });

  test("a HEAD request answers the same redirect", async () => {
    const app = buildApp({ links: new MemoryLinks().make("q3-plan", "https://example.com/a") });
    const res = await app.inject({ method: "HEAD", url: "/q3-plan" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://example.com/a");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
