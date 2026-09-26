// The `linkling` command (R-015, ADR-0015), run in-process against the real app. What each
// command prints, what each way of failing exits with, and that a service that is not there,
// or not Linkling's, is a failure and never a pass. R-008's half is in tests/made-by.test.ts.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT, TIMEOUT_MS, settings } from "../src/cli.js";
import { MADE, seed } from "./support/app.js";
import { linkling, stack } from "./support/cli.js";
import { TEST_KEY } from "./support/team-key.js";

const NOW = () => MADE;

/** A `fetch` that fails the test if the command makes a request at all. */
function noRequests() {
  const calls: string[] = [];
  const fetchDouble = (async (input: unknown) => {
    calls.push(String(input));
    throw new Error("no request was expected");
  }) as typeof fetch;
  return { calls, fetch: fetchDouble };
}

/** A `fetch` that answers every request with `answer`, and keeps what it was asked. */
function answering(answer: () => Response | Promise<Response>) {
  const asked: { url: string; init: RequestInit }[] = [];
  const fetchDouble = (async (input: unknown, init: RequestInit = {}) => {
    asked.push({ url: String(input), init });
    return answer();
  }) as typeof fetch;
  return { asked, fetch: fetchDouble };
}

const others: Server[] = [];
afterEach(async () => {
  // A server that never ends its answer would keep close() waiting for the connection.
  for (const server of others) server.closeAllConnections();
  await Promise.all(others.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** Some other web server, that answers every request the same way. Returns its address. */
async function otherServer(status: number, headers: Record<string, string>, body: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  });
  others.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A server that takes the request and never finishes answering it: no answer at all, or one that stops after the headers. */
async function stallingServer(afterHeaders: boolean): Promise<string> {
  const server = createServer((_req, res) => {
    if (afterHeaders) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"links":');
    }
  });
  others.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("R-015 a team member does all of it from the command line", () => {
  test("R-015: make, list, edit, counts and delete, in the order R-015's verify line runs them", async () => {
    const { app, base, run } = await stack({ now: NOW });

    expect(await run(["make", "https://example.com/c", "--name", "cli-test"])).toEqual({
      code: 0,
      out: `${base}/cli-test\n`,
      err: "",
    });
    expect(await run(["list"])).toEqual({
      code: 0,
      out: "NAME      MADE BY  EXPIRES  TARGET\ncli-test  tester   never    https://example.com/c\n",
      err: "",
    });
    expect(await run(["edit", "cli-test", "https://example.com/d"])).toEqual({
      code: 0,
      out: `${base}/cli-test -> https://example.com/d\n`,
      err: "",
    });
    const follow = await app.inject({ method: "GET", url: "/cli-test" });
    expect([follow.statusCode, follow.headers.location]).toEqual([302, "https://example.com/d"]);

    // Two follows, both on the app's fixed UTC day.
    await app.inject({ method: "GET", url: "/cli-test" });
    expect(await run(["counts", "cli-test"])).toEqual({ code: 0, out: "cli-test: 2 total\n2026-09-26  2\n", err: "" });

    expect(await run(["delete", "cli-test"])).toEqual({ code: 0, out: "deleted cli-test\n", err: "" });
    expect((await app.inject({ method: "GET", url: "/cli-test" })).statusCode).toBe(404);
    expect(await run(["list"])).toEqual({ code: 0, out: "", err: "no links yet\n" });
  });

  test("a link with no counts shows a total of 0 and no day lines", async () => {
    const { run } = await stack({ now: NOW });
    await run(["make", "https://example.com/c", "--name", "quiet"]);
    expect(await run(["counts", "quiet"])).toEqual({ code: 0, out: "quiet: 0 total\n", err: "" });
  });

  test("make with no name prints a made-up one, six characters from the made-up alphabet", async () => {
    const { base, run } = await stack();
    const made = await run(["make", "https://example.com/c"]);
    expect(made.code).toBe(0);
    expect(made.out).toMatch(new RegExp(`^${base}/[a-hjkmnp-z2-9]{6}\\n$`));
  });

  test("make --expires takes a lifetime or a date, and list shows the moment it ends", async () => {
    const { run } = await stack({ now: NOW });
    await run(["make", "https://example.com/a", "--name", "week", "--expires", "7d"]);
    await run(["make", "https://example.com/b", "--name", "dated", "--expires=2026-10-01"]);
    const listed = await run(["list"]);
    expect(listed.out).toMatch(/^week\s+tester\s+2026-10-03T12:00:00\.000Z\s+https:\/\/example\.com\/a$/m);
    expect(listed.out).toMatch(/^dated\s+tester\s+2026-10-01T23:59:59\.999Z\s+https:\/\/example\.com\/b$/m);
  });

  test("R-006: a link made with no expiry lists as never, and a made one lists an expiry", async () => {
    const { run } = await stack({ now: NOW });
    await run(["make", "https://example.com/a", "--name", "forever"]);
    const listed = (await run(["list"])).out.trimEnd().split("\n");
    expect(listed[1]).toMatch(/^forever\s+tester\s+never\s+https:\/\/example\.com\/a$/);
  });

  test("list marks an expired link, shows an empty made-by as a dash, and edit says an expired link stays expired", async () => {
    const { app, run } = await stack({ now: () => new Date("2026-10-01T00:00:00Z") });
    seed(app.links, "old", "https://example.com/o", new Date("2026-09-26T12:00:01Z"));
    seed(app.links, "anon", "https://example.com/n", null, { madeBy: "" });
    const listed = await run(["list"]);
    expect(listed.out).toMatch(/^old\s+sam\s+expired 2026-09-26T12:00:01\.000Z\s+https:\/\/example\.com\/o$/m);
    expect(listed.out).toMatch(/^anon\s+-\s+never\s+https:\/\/example\.com\/n$/m);

    const edited = await run(["edit", "old", "https://example.com/p"]);
    expect(edited.code).toBe(0);
    expect(edited.err).toBe("linkling: note: old has expired; changing its target does not bring it back\n");
  });

  test("list lines its columns up as a terminal shows them: an emoji or a Chinese character takes two columns", async () => {
    const { app, run } = await stack({ now: NOW });
    seed(app.links, "party", "https://example.com/p", null, { madeBy: "🎉" });
    seed(app.links, "plain", "https://example.com/q", null, { madeBy: "sam" });
    seed(app.links, "cjk", "https://example.com/r", null, { madeBy: "山田" });
    seed(app.links, "accent", "https://example.com/s", null, { madeBy: "é" });
    const out = (await run(["list"])).out;
    // NAME is 6 wide (accent), MADE BY is 7 (its own heading): each cell is padded to that in
    // terminal columns, then two spaces. The spaces below are counted by hand from the widths:
    // 🎉 is 2 columns (5 + 2 = 7 spaces), sam is 3 (4 + 2 = 6), 山田 is 4 (3 + 2 = 5), and an e with a
    // combining accent is 1 (6 + 2 = 8).
    expect(out).toContain("party   🎉       never");
    expect(out).toContain("plain   sam      never");
    expect(out).toContain("cjk     山田     never");
    expect(out).toContain("accent  é        never");
  });

  test("a name is folded to lower case, as the API folds it", async () => {
    const { run } = await stack();
    await run(["make", "https://example.com/a", "--name", "Q3-Plan"]);
    expect((await run(["edit", "Q3-PLAN", "https://example.com/b"])).code).toBe(0);
    expect(await run(["delete", "Q3-Plan"])).toEqual({ code: 0, out: "deleted Q3-Plan\n", err: "" });
  });
});

describe("--json prints the service's own answer, as one line", () => {
  test("for make, list, edit and counts it is the API's JSON, and for delete a small confirmation", async () => {
    const { app, run } = await stack({ now: NOW });
    const url = "https://example.com/j";

    const made = await run(["make", url, "--name", "j", "--by", "ana", "--json"]);
    const link = {
      name: "j",
      url,
      made_by: "ana",
      created_at: "2026-09-26T12:00:00.000Z",
      expires_at: null,
      expired: false,
    };
    expect(made.code).toBe(0);
    expect(made.out).toBe(`${JSON.stringify(link)}\n`);

    const listed = await run(["list", "--json"]);
    expect(JSON.parse(listed.out)).toEqual({ links: [link] });
    expect(listed.out.trimEnd().split("\n")).toHaveLength(1);

    const edited = await run(["edit", "j", "https://example.com/k", "--json"]);
    expect(JSON.parse(edited.out)).toEqual({ ...link, url: "https://example.com/k" });

    await app.inject({ method: "GET", url: "/j" });
    expect(JSON.parse((await run(["counts", "j", "--json"])).out)).toEqual({
      name: "j",
      total: 1,
      days: [{ day: "2026-09-26", count: 1 }],
    });

    expect(JSON.parse((await run(["delete", "j", "--json"])).out)).toEqual({ name: "j", deleted: true });
    expect(JSON.parse((await run(["list", "--json"])).out)).toEqual({ links: [] });
  });
});

describe("the service says no: exit 1, and its own sentence", () => {
  test("R-003: a taken name is refused by name, and the first link is untouched", async () => {
    const { app, run } = await stack();
    await run(["make", "https://example.com/first", "--name", "q3-plan"]);
    const again = await run(["make", "https://example.com/second", "--name", "q3-plan"]);
    expect(again).toEqual({ code: EXIT.refused, out: "", err: 'linkling: the name "q3-plan" is already taken (409)\n' });
    const follow = await app.inject({ method: "GET", url: "/q3-plan" });
    expect(follow.headers.location).toBe("https://example.com/first");
  });

  test("a link that is not there is a 404 on edit, delete and counts", async () => {
    const { run } = await stack();
    for (const argv of [["edit", "nope", "https://example.com/x"], ["delete", "nope"], ["counts", "nope"]]) {
      expect(await run(argv), argv.join(" ")).toEqual({ code: 1, out: "", err: 'linkling: no link is named "nope" (404)\n' });
    }
  });

  test("a value the API refuses comes back as the API's sentence", async () => {
    const { app, run } = await stack({ now: NOW });
    const refused: [string[], string][] = [
      [["make", "not a url"], "url must be an absolute http or https URL (400)"],
      [["make", "https://example.com/a", "--name=-x"], "name must be 1–64 letters, digits and hyphens, not starting with a hyphen (400)"],
      [["make", "https://example.com/a", "--expires", "tomorrow"], "expires must be a date (YYYY-MM-DD) or a lifetime such as 7d (s, m, h or d) (400)"],
      [["make", "https://example.com/a", "--by", "x".repeat(65)], "made_by must be a string of at most 64 characters with no line breaks (400)"],
    ];
    for (const [argv, sentence] of refused) {
      expect(await run(argv), argv.join(" ")).toEqual({ code: 1, out: "", err: `linkling: ${sentence}\n` });
    }
    expect(app.links.list()).toEqual([]);
  });

  test("a 410, which the API itself never sends, is the service saying no too", async () => {
    const double = answering(() => new Response(JSON.stringify({ error: "this link has expired" }), { status: 410 }));
    const { run } = await stack();
    expect(await run(["edit", "old", "https://example.com/x"], {}, { fetch: double.fetch })).toEqual({
      code: 1,
      out: "",
      err: "linkling: this link has expired (410)\n",
    });
  });

  test("delete of '..' or '.' is refused before any request, so it cannot leave /-/api/links/", async () => {
    const { app, run } = await stack();
    await run(["make", "https://example.com/a", "--name", "keep"]);
    const none = noRequests();
    for (const name of ["..", "."]) {
      const ran = await run(["delete", name], {}, { fetch: none.fetch });
      expect([name, ran.code, ran.out]).toEqual([name, EXIT.usage, ""]);
    }
    expect(none.calls).toEqual([]);
    expect(app.links.list().map((l) => l.name)).toEqual(["keep"]);
  });
});

describe("the key: exit 3 when it is refused, exit 2 when it cannot be sent", () => {
  test("a wrong key is 401 on every command, and makes nothing", async () => {
    const { app, run } = await stack();
    const wrong = { LINKLING_KEY: "not-the-team-key" };
    const argvs = [["make", "https://example.com/a", "--name", "x"], ["list"], ["edit", "x", "https://example.com/b"], ["delete", "x"], ["counts", "x"]];
    for (const argv of argvs) {
      expect(await run(argv, wrong), argv.join(" ")).toEqual({
        code: EXIT.key,
        out: "",
        err: "linkling: the service refused LINKLING_KEY (401); check the team key\n",
      });
    }
    expect(app.links.list()).toEqual([]);
  });

  test("a key that is missing or cannot travel in a header is a usage error, and no request is made", async () => {
    const none = noRequests();
    const { run } = await stack();
    for (const key of [undefined, "", "two words", "clé-secrète", "line\nbreak"]) {
      const ran = await run(["list"], { LINKLING_KEY: key }, { fetch: none.fetch });
      expect([key, ran.code, ran.out, ran.err.startsWith("linkling: LINKLING_KEY ")]).toEqual([key, EXIT.usage, "", true]);
    }
    expect(none.calls).toEqual([]);
  });
});

describe("the address: LINKLING_BASE", () => {
  test("missing, and not an origin, are usage errors; the address is never echoed", async () => {
    const none = noRequests();
    const { run } = await stack();
    const missing = await run(["list"], { LINKLING_BASE: undefined }, { fetch: none.fetch });
    expect(missing).toEqual({
      code: EXIT.usage,
      out: "",
      err: "linkling: LINKLING_BASE is not set; set it to where the service answers, such as http://localhost:8080\n",
    });
    for (const base of ["", "localhost:8080", "ftp://example.com", "http://example.com/links", "http://example.com/?x=1", "http://ana:hunter2@example.com", "not a url"]) {
      const ran = await run(["list"], { LINKLING_BASE: base }, { fetch: none.fetch });
      expect([base, ran.code]).toEqual([base, EXIT.usage]);
      expect(ran.err).not.toContain("hunter2");
      if (base !== "") expect(ran.err).toContain("LINKLING_BASE must be an http or https address with no path");
    }
    expect(none.calls).toEqual([]);
  });

  test("a trailing slash is fine, and short links are printed without a doubled one", async () => {
    const { base, run } = await stack();
    const made = await run(["make", "https://example.com/a", "--name", "slash"], { LINKLING_BASE: `${base}/` });
    expect(made).toEqual({ code: 0, out: `${base}/slash\n`, err: "" });
  });
});

describe("the command line: exit 2, a message, and no request", () => {
  const cases: [string, string[]][] = [
    ["no command", []],
    ["an unknown command", ["frobnicate"]],
    ["a command name that is on Object's prototype", ["constructor"]],
    ["--json in place of a command", ["--json"]],
    ["make with no url", ["make"]],
    ["make with two urls", ["make", "https://a.example", "https://b.example"]],
    ["make with an option it does not have", ["make", "https://a.example", "--nme", "x"]],
    ["make --name with no value", ["make", "https://a.example", "--name"]],
    ["make --by with a blank name", ["make", "https://a.example", "--by", "  "]],
    ["edit with one argument", ["edit", "q3-plan"]],
    ["list with an argument", ["list", "extra"]],
    ["delete with an option it does not have", ["delete", "x", "--name", "y"]],
    ["counts with no name", ["counts"]],
  ];
  for (const [label, argv] of cases) {
    test(`${label}`, async () => {
      const none = noRequests();
      const { run } = await stack();
      const ran = await run(argv, {}, { fetch: none.fetch });
      expect([ran.code, ran.out, ran.err.startsWith("linkling: ")]).toEqual([EXIT.usage, "", true]);
      expect(none.calls).toEqual([]);
    });
  }

  test("--help, -h and help print the usage on stdout and exit 0, with no address or key set", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["make", "--help"], ["list", "-h"]]) {
      const ran = await linkling(argv, {});
      expect([argv, ran.code, ran.err]).toEqual([argv, 0, ""]);
      expect(ran.out).toContain("usage: linkling <command> [options]");
      expect(ran.out).toContain("exit codes:");
    }
  });
});

describe("no usable answer: exit 4, never 0", () => {
  test("a service that is not there", async () => {
    const { app, run } = await stack();
    await app.close();
    const ran = await run(["list"]);
    expect([ran.code, ran.out]).toEqual([EXIT.noAnswer, ""]);
    expect(ran.err).toMatch(/^linkling: cannot reach http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED\n$/);
  });

  test("a service that does not answer in time, or stops partway through its answer, is given up on", async () => {
    const { run } = await stack();
    for (const afterHeaders of [false, true]) {
      const base = await stallingServer(afterHeaders);
      const started = Date.now();
      // The real fetch and the real AbortSignal, with the wait shortened from TIMEOUT_MS.
      const ran = await run(["list"], { LINKLING_BASE: base }, { timeoutMs: 300 });
      expect([afterHeaders, ran]).toEqual([
        afterHeaders,
        { code: EXIT.noAnswer, out: "", err: `linkling: cannot reach ${base}: no answer within 0.3 s\n` },
      ]);
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS / 2);
    }
  });

  test("the wait is 10 s unless a test shortens it, and the wait a request is given comes from settings", () => {
    const env = { LINKLING_BASE: "http://localhost:8080", LINKLING_KEY: TEST_KEY };
    expect(TIMEOUT_MS).toBe(10_000);
    expect(settings({ env, stdout: () => {}, stderr: () => {} }).timeoutMs).toBe(TIMEOUT_MS);
    expect(settings({ env, stdout: () => {}, stderr: () => {}, timeoutMs: 300 }).timeoutMs).toBe(300);
  });

  test("a port fetch refuses is said to be refused, not just 'fetch failed'", async () => {
    const { run } = await stack();
    // 6000 is on the list of ports fetch will not connect to, so this needs no server and no wait.
    const ran = await run(["list"], { LINKLING_BASE: "http://127.0.0.1:6000" });
    expect(ran).toEqual({ code: EXIT.noAnswer, out: "", err: "linkling: cannot reach http://127.0.0.1:6000: bad port\n" });
  });

  test("an answer to make that is not a link says which status it came with", async () => {
    const double = answering(() => new Response("{}", { status: 201 }));
    const { base, run } = await stack();
    const ran = await run(["make", "https://example.com/a"], {}, { fetch: double.fetch });
    expect(ran).toEqual({
      code: EXIT.noAnswer,
      out: "",
      err: `linkling: ${base} answered 201, but not the way Linkling's API does; is LINKLING_BASE right?\n`,
    });
  });

  test("every request is bearer-authenticated, is never redirected, and can be given up on", async () => {
    const double = answering(() => new Response(JSON.stringify({ links: [] }), { status: 200 }));
    const { base, run } = await stack();
    await run(["list"], {}, { fetch: double.fetch });
    const [call] = double.asked;
    expect(call!.url).toBe(`${base}/-/api/links`);
    expect(call!.init.redirect).toBe("manual");
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(call!.init.headers).get("authorization")).toBe("Bearer correct-horse-battery-staple");
  });

  test("a redirect is reported, and a POST is never replayed as a GET", async () => {
    const base = await otherServer(301, { location: "https://elsewhere.invalid/" }, "");
    const { run } = await stack();
    const ran = await run(["make", "https://example.com/a"], { LINKLING_BASE: base });
    expect(ran).toEqual({
      code: EXIT.noAnswer,
      out: "",
      err: `linkling: ${base} answered 301, which Linkling's API never sends; if it is redirecting, set LINKLING_BASE to where it redirects to\n`,
    });
  });

  test("some other web server is exit 4 whatever it answers, so a wrong LINKLING_BASE is never a pass or a crash", async () => {
    const { run } = await stack();
    const html = { "content-type": "text/html" };
    const json = { "content-type": "application/json" };
    const answers: [string, number, Record<string, string>, string][] = [
      ["an HTML page", 200, html, "<html>hello</html>"],
      ["an HTML 404", 404, html, "<html>not found</html>"],
      // What a stock Fastify app answers for a route it does not have: JSON, with an `error` field.
      ["a Fastify 404", 404, json, '{"message":"Route GET:/-/api/links not found","error":"Not Found","statusCode":404}'],
      ["JSON with an error field and more", 400, json, '{"error":"Bad Request","message":"x"}'],
      ["JSON that is not the API's list", 200, json, '{"links":"none"}'],
      ["an empty 200", 200, {}, ""],
      ["a 500 that is not the API's", 500, html, "oops"],
    ];
    const commands = [["list"], ["make", "https://example.com/a"], ["edit", "x", "https://example.com/a"], ["delete", "x"], ["counts", "x"]];
    for (const [label, status, headers, body] of answers) {
      const base = await otherServer(status, headers, body);
      for (const argv of commands) {
        const ran = await run(argv, { LINKLING_BASE: base });
        expect([label, argv[0], ran.code, ran.out]).toEqual([label, argv[0], EXIT.noAnswer, ""]);
        expect(ran.err).toContain(`answered ${status}`);
      }
    }
  });

  test("the API's own 500 is exit 4, with its sentence", async () => {
    const double = answering(() => new Response(JSON.stringify({ error: "Something went wrong." }), { status: 500 }));
    const { run } = await stack();
    expect(await run(["list"], {}, { fetch: double.fetch })).toEqual({
      code: EXIT.noAnswer,
      out: "",
      err: "linkling: Something went wrong. (500)\n",
    });
  });
});

describe("the command itself", () => {
  test("a bug is exit 70, which no other failure uses", async () => {
    const ran = await linkling(["help"], {}, {
      stdout: () => {
        throw new Error("boom");
      },
    });
    expect(ran.code).toBe(EXIT.bug);
    expect(ran.err).toBe("linkling: internal error: boom\n");
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
  });

  test("src/cli.ts loads only node: modules and team-key.ts, so it never starts Fastify or SQLite", () => {
    const external = new Set<string>();
    const visited: string[] = [];
    const queue = ["src/cli.ts"];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (visited.includes(file)) continue;
      visited.push(file);
      const source = readFileSync(join(import.meta.dirname, "..", file), "utf8");
      for (const match of source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g)) {
        const specifier = match[1] ?? match[2]!;
        if (specifier.startsWith(".")) queue.push(join("src", specifier.replace(/\.js$/, ".ts")));
        else external.add(specifier);
      }
    }
    // Exact, so a walk that found nothing fails here rather than passing on an empty set.
    expect(visited.sort()).toEqual(["src/cli.ts", "src/team-key.ts"]);
    expect([...external].sort()).toEqual(["node:crypto", "node:os", "node:util"]);
  });
});
