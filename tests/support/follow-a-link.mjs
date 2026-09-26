// The child process tests/nothing-about-clickers.test.ts runs: the real app over the real
// database, followed by a clicker whose address, browser and referrer the test chose. It
// runs in its own process so the test can read everything written to file descriptors 1
// and 2, whether through console, process.stdout or a logger writing to the descriptor
// directly.
//
//   node follow-a-link.mjs <database-path> <json: { address, userAgent, referrer }>
//
// It writes exactly five lines of its own: a canary through console.log, one straight to
// descriptor 1, one through console.error and one straight to descriptor 2, all before
// the app exists, and last a DONE line with the status codes it saw. Anything else in its output came from the app.
import { existsSync, writeSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const CANARY_CONSOLE = "follow-a-link: canary via console.log";
const CANARY_FD = "follow-a-link: canary via fd 1";
const CANARY_ERR_CONSOLE = "follow-a-link: canary via console.error";
const CANARY_ERR_FD = "follow-a-link: canary via fd 2";

// The sources import each other as ./x.js (NodeNext); Node strips the types but does not
// map .js to .ts, so this does, for relative imports from a .ts file only.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});

const [dbPath, clickerJson] = process.argv.slice(2);
const clicker = JSON.parse(clickerJson);

console.log(CANARY_CONSOLE);
writeSync(1, `${CANARY_FD}\n`);
console.error(CANARY_ERR_CONSOLE);
writeSync(2, `${CANARY_ERR_FD}\n`);

const { buildApp } = await import("../../src/app.ts");
const { openDatabase } = await import("../../src/db/open.ts");
const { createLink, getLinkByName } = await import("../../src/db/links.ts");

const now = new Date("2026-09-26T12:00:00Z");
const db = openDatabase(dbPath);
createLink(db, { name: "q3-plan", target: "https://example.com/q3", madeBy: "sam", expiresAt: null }, now);
createLink(db, { name: "old", target: "https://example.com/old", madeBy: "sam", expiresAt: new Date("2026-01-01T00:00:00Z") }, now);

// A store over the real database. The route does not count follows yet (LL-007 wires
// counting and the server's own store); when it does, this should build the app the way
// src/server.ts does, so the database scan sees what a real follow writes.
const links = {
  async lookup(name) {
    if (name === "boom") throw new Error(`store failed for ${clicker.address}`);
    const link = getLinkByName(db, name);
    return link === undefined ? null : { target: link.target, expiresAt: link.expiresAt === null ? null : new Date(link.expiresAt) };
  },
};

const app = buildApp({ links, key: "team-key-for-the-test", now: () => now });
// Behind a proxy the address arrives in a header, not as the socket's peer, so it is sent
// in every header a proxy uses for it as well.
const headers = {
  "user-agent": clicker.userAgent,
  referer: clicker.referrer,
  "x-forwarded-for": clicker.address,
  forwarded: `for=${clicker.address}`,
  "x-real-ip": clicker.address,
};
const statuses = [];
for (const url of ["/q3-plan", "/nope", "/old", "/boom", "/%zz", "/-/nothing-here"]) {
  const res = await app.inject({ method: "GET", url, remoteAddress: clicker.address, headers });
  statuses.push(res.statusCode);
  if (url === "/q3-plan" && res.headers.location !== "https://example.com/q3") statuses.push("bad-location");
  // The privacy page says the service sets no cookies.
  if (res.headers["set-cookie"] !== undefined) statuses.push(`cookie on ${url}`);
}

// The same over a real socket, where Node's HTTP server is in the path too: one follow,
// then a request line no server can parse, which goes through the client-error path
// instead of a route. The socket's own address is the loopback one here, so on this leg
// the clicker's address is only in the proxy headers.
await app.listen({ host: "127.0.0.1", port: 0 });
const { port } = app.server.address();
statuses.push(
  await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/q3-plan", headers }, (res) => {
      res.resume();
      resolve(res.headers["set-cookie"] === undefined ? res.statusCode : `cookie on socket ${res.statusCode}`);
    }).on("error", reject).end();
  }),
);
statuses.push(
  await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`NOT HTTP ${clicker.userAgent}\r\n\r\n`));
    let reply = "";
    socket.on("data", (d) => (reply += d));
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
    socket.on("error", reject);
  }),
);
await app.close();

// Nothing a follow writes reaches the database yet, so the scan has nothing of a follow
// to look at. When LL-007 makes follows count, this fails: build the app the way
// src/server.ts does from then on, so the scan covers what a real follow writes.
const counted = db.prepare("SELECT count(*) AS n FROM daily_counts").get().n;
if (counted !== 0) statuses.push("counting is wired: build the app the way src/server.ts does");
db.close();

writeSync(1, `follow-a-link: DONE ${JSON.stringify(statuses)}\n`);
