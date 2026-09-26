// Only someone with the team key can make, delete or list links, or see the stats (R-014),
// and the key is one shared secret sent as Bearer or as the Basic password (ADR-0005).
import { connect, type AddressInfo } from "node:net";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { seed, tempLinks } from "./support/app.js";
import { basic, bearer, TEST_KEY } from "./support/team-key.js";

const CHALLENGE = 'Basic realm="Linkling", charset="UTF-8"';

/**
 * The app at the two paths R-014's verify line calls: the real list route, and a stand-in
 * for the stats page (LL-008), registered after buildApp returns the way it will be.
 * `ran` counts the times either reached its store or handler.
 */
function guarded() {
  const links = tempLinks();
  const ran = { count: 0 };
  const list = links.list.bind(links);
  links.list = () => {
    ran.count++;
    return list();
  };
  const app = buildApp({ links, key: TEST_KEY });
  app.get("/-/stats", async () => {
    ran.count++;
    return "the stats";
  });
  return { app, ran };
}

function expectRefused(res: LightMyRequestResponse): void {
  expect(res.statusCode).toBe(401);
  expect(res.headers["www-authenticate"]).toBe(CHALLENGE);
  expect(res.headers["set-cookie"]).toBeUndefined();
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.body).toBe("The team key is needed.\n");
}

describe("R-014 the team key", () => {
  test("R-014: listing links and the stats page are refused without the key", async () => {
    const { app, ran } = guarded();
    for (const url of ["/-/api/links", "/-/stats"]) {
      expectRefused(await app.inject({ method: "GET", url }));
    }
    expect(ran.count).toBe(0);
  });

  test("R-014: a wrong key is refused, as Bearer and as the Basic password", async () => {
    const { app, ran } = guarded();
    const wrong = [
      bearer("not-the-key"),
      bearer(TEST_KEY.slice(0, -1)),
      bearer(`${TEST_KEY}x`),
      basic("ana", "not-the-key"),
      basic(TEST_KEY, ""),
      { authorization: `Basic ${Buffer.from(TEST_KEY).toString("base64")}` },
      { authorization: `Token ${TEST_KEY}` },
      { authorization: TEST_KEY },
      { authorization: "Bearer" },
    ];
    for (const headers of wrong) {
      expectRefused(await app.inject({ method: "GET", url: "/-/api/links", headers }));
    }
    expect(ran.count).toBe(0);
  });

  test("R-014: the key is accepted as Bearer, and as the Basic password with any user name", async () => {
    const { app, ran } = guarded();
    const right = [
      bearer(TEST_KEY),
      { authorization: `bearer ${TEST_KEY}` },
      basic("ana", TEST_KEY),
      basic("", TEST_KEY),
    ];
    for (const headers of right) {
      const res = await app.inject({ method: "GET", url: "/-/stats", headers });
      expect([res.statusCode, res.body]).toEqual([200, "the stats"]);
    }
    expect(ran.count).toBe(right.length);
  });

  test("R-014: a Basic password holding a colon is the whole key", async () => {
    const app = buildApp({ links: tempLinks(), key: "a:b" });
    app.get("/-/stats", async () => "the stats");
    const res = await app.inject({ method: "GET", url: "/-/stats", headers: basic("ana", "a:b") });
    expect(res.statusCode).toBe(200);
  });

  test("R-014: an encoded path that routes to a guarded route is still refused", async () => {
    const { app, ran } = guarded();
    for (const url of ["/%2D/api/links", "/%2d/stats", "/-/api/li%6Eks", "/-/x/../stats", "/-/stats/"]) {
      expectRefused(await app.inject({ method: "GET", url }));
    }
    expect(ran.count).toBe(0);
  });

  test("R-014: a route added later, inside a prefixed plugin, is guarded too", async () => {
    const app = buildApp({ links: tempLinks(), key: TEST_KEY });
    await app.register(
      async (api) => {
        api.delete("/probe/:name", async () => "deleted");
      },
      { prefix: "/-/api" },
    );
    expectRefused(await app.inject({ method: "DELETE", url: "/-/api/probe/q3-plan" }));
    const res = await app.inject({ method: "DELETE", url: "/-/api/probe/q3-plan", headers: bearer(TEST_KEY) });
    expect([res.statusCode, res.body]).toEqual([200, "deleted"]);
  });

  test("R-014: only /-/health itself is open, not routes that start like it", async () => {
    const { app } = guarded();
    app.get("/-/healthz", async () => "no");
    app.get("/-/health/details", async () => "no");
    for (const url of ["/-/healthz", "/-/health/details"]) {
      expectRefused(await app.inject({ method: "GET", url }));
    }
  });

  test("R-014: HEAD on a guarded route is refused too", async () => {
    const { app, ran } = guarded();
    const res = await app.inject({ method: "HEAD", url: "/-/stats" });
    expect([res.statusCode, res.headers["www-authenticate"]]).toEqual([401, CHALLENGE]);
    expect(ran.count).toBe(0);
  });

  test("health answers without the key and says nothing else", async () => {
    const { app } = guarded();
    const res = await app.inject({ method: "GET", url: "/-/health" });
    expect([res.statusCode, res.body]).toEqual([200, "ok\n"]);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  test("an app cannot be built without a usable key", () => {
    for (const key of ["", "   ", `${TEST_KEY}\n`]) {
      expect(() => buildApp({ links: tempLinks(), key })).toThrow("an app cannot be built without a usable one");
    }
  });

  test("R-014: every API route is refused without the key, and changes nothing", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    const app = buildApp({ links, key: TEST_KEY });
    const calls: [string, string, unknown?][] = [
      ["POST", "/-/api/links", { url: "https://example.com/new", name: "new" }],
      ["GET", "/-/api/links"],
      ["GET", "/-/api/links/q3-plan"],
      ["PATCH", "/-/api/links/q3-plan", { url: "https://example.com/other" }],
      ["DELETE", "/-/api/links/q3-plan"],
      ["GET", "/-/api/links/q3-plan/counts"],
    ];
    for (const [method, url, body] of calls) {
      for (const headers of [{}, bearer("not-the-key")]) {
        const res = await app.inject({
          method: method as "GET",
          url,
          headers: { ...headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
        });
        expect(`${method} ${url} ${res.statusCode}`).toBe(`${method} ${url} 401`);
      }
    }
    expect(links.list().map((l) => [l.name, l.target])).toEqual([["q3-plan", "https://example.com/q3"]]);
  });
});

// inject() normalizes `/..` before routing, so path traversal is tested over a real socket
// with the request line written by hand.
describe("R-014 over a real socket", () => {
  const opened: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close()));
  });

  async function statusOf(port: number, path: string, headers = ""): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: linkling.test\r\n${headers}Connection: close\r\n\r\n`);
      });
      let data = "";
      socket.setEncoding("latin1");
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
      socket.on("error", reject);
    });
  }

  test("R-014: a dot-segment path never reaches the list without the key", async () => {
    const links = tempLinks();
    seed(links, "q3-plan", "https://example.com/q3");
    const app = buildApp({ links, key: TEST_KEY });
    opened.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    // Fixed population first: the harness reads a 200 when the key is there.
    expect(await statusOf(port, "/-/api/links", `Authorization: Bearer ${TEST_KEY}\r\n`)).toBe("HTTP/1.1 200 OK");

    for (const path of [
      "/-/api/links",
      "/-/api/links/../links",
      "/-/api/../api/links",
      "/x/../-/api/links",
      "/./-/api/links",
      "/-/health/../api/links",
      "/%2D/api/links",
      "/-/api/links/%2e%2e/links",
      "//-/api/links",
    ]) {
      expect(["HTTP/1.1 401 Unauthorized", "HTTP/1.1 404 Not Found"], path).toContain(await statusOf(port, path));
    }
  });
});
