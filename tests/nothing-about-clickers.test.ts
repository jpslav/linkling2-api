import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { tempDir } from "./temp-db.js";

// R-020 (ADR-0004): nothing about the person clicking reaches the database or the
// service's logs. tests/support/follow-a-link.mjs runs the real app over a real database
// file in a child process and follows links as a clicker whose address, browser and
// referrer are set here; this reads back everything the child wrote to stdout and stderr,
// and every byte of the database files.

const CHILD = fileURLToPath(new URL("./support/follow-a-link.mjs", import.meta.url));
const CANARY_CONSOLE = "follow-a-link: canary via console.log";
const CANARY_FD = "follow-a-link: canary via fd 1";
const CANARY_ERR_CONSOLE = "follow-a-link: canary via console.error";
const CANARY_ERR_FD = "follow-a-link: canary via fd 2";
const DONE = "follow-a-link: DONE [302,404,410,500,404,404,302,400]";

// Strings nothing else in the app, the database or the output could contain by chance.
const clicker = {
  address: "203.0.113.77",
  userAgent: "ClickerBrowser/9.9 (canary-ua-5b1e)",
  referrer: "https://referrer.example/canary-ref-8c2d",
};

function follow(): { stdout: string; stderr: string; dbBytes: Buffer; status: number | null } {| null } {
  const dir = tempDir();
  const dbPath = join(dir, "linkling.db");
  const run = spawnSync(process.execPath, [CHILD, dbPath, JSON.stringify(clicker)], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (run.error) throw run.error;
  // The main file and whatever SQLite left beside it; closing the last connection
  // normally folds the -wal file back into the main file and removes both.
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].filter((f) => existsSync(f));
  return {
    stdout: run.stdout,
    stderr: run.stderr,
    dbBytes: Buffer.concat(files.map((f) => readFileSync(f))),
    status: run.status,
  };
}

test("following links writes no log line and stores nothing about the clicker", () => {
  const { stdout, stderr, dbBytes, status } = follow();
  const output = stdout + stderr;

  // Blind arms: if the capture or the scan saw nothing, the content checks below would
  // pass for the wrong reason.
  expect(stdout, "blind: the console.log canary never reached the captured stdout").toContain(CANARY_CONSOLE);
  expect(stdout, "blind: the fd 1 canary never reached the captured stdout").toContain(CANARY_FD);
  expect(stderr, "blind: the console.error canary never reached the captured stderr").toContain(CANARY_ERR_CONSOLE);
  expect(stderr, "blind: the fd 2 canary never reached the captured stderr").toContain(CANARY_ERR_FD);
  expect(dbBytes.length, "blind: the database files were empty or missing").toBeGreaterThan(0);
  expect(dbBytes.includes("https://example.com/q3"), "blind: the link's own target is not in the bytes read").toBe(true);

  expect(status, output).toBe(0);
  // Through inject: 302 for the link, 404 unknown, 410 expired, 500 store failure, 404 bad
  // escape, 404 /-/. Over a socket: 302 for the link, 400 for a request line that is not HTTP.
  // A cookie on any response, or a follow that wrote to the database, would appear in this
  // line too.
  expect(stdout).toContain(DONE);

  // No request log: the child's own lines are the whole output.
  const lines = (s: string): string[] => s.split("\n").filter((l) => l.length > 0);
  expect(lines(stdout)).toEqual([CANARY_CONSOLE, CANARY_FD, DONE]);
  expect(lines(stderr)).toEqual([CANARY_ERR_CONSOLE, CANARY_ERR_FD]);

  for (const [what, value] of Object.entries(clicker)) {
    expect(output.includes(value), `the clicker's ${what} is in the service's output`).toBe(false);
    expect(dbBytes.includes(value), `the clicker's ${what} is in the database`).toBe(false);
  }
});
