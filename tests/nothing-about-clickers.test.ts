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

// Strings nothing else in the app, the database or the output could contain by chance.
const clicker = {
  address: "203.0.113.77",
  userAgent: "ClickerBrowser/9.9 (canary-ua-5b1e)",
  referrer: "https://referrer.example/canary-ref-8c2d",
};

function follow(): { output: string; dbBytes: Buffer; status: number | null } {
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
    output: run.stdout + run.stderr,
    dbBytes: Buffer.concat(files.map((f) => readFileSync(f))),
    status: run.status,
  };
}

test("following links writes no log line and stores nothing about the clicker", () => {
  const { output, dbBytes, status } = follow();

  // Blind arms: if the capture or the scan saw nothing, the content checks below would
  // pass for the wrong reason.
  expect(output, "blind: the console canary never reached the captured output").toContain(CANARY_CONSOLE);
  expect(output, "blind: the fd 1 canary never reached the captured output").toContain(CANARY_FD);
  expect(dbBytes.length, "blind: the database files were empty or missing").toBeGreaterThan(0);
  expect(dbBytes.includes("https://example.com/q3"), "blind: the link's own target is not in the bytes read").toBe(true);

  expect(status, output).toBe(0);
  // Through inject: 302 for the link, 404 unknown, 410 expired, 500 store failure, 404 bad
  // escape, 404 /-/. Over a socket: 302 for the link, 400 for a request line that is not HTTP.
  // A cookie on any response would appear in this line too.
  expect(output).toContain('follow-a-link: DONE [302,404,410,500,404,404,302,400]');

  // No request log: the child's own three lines are the whole output.
  const lines = output.split("\n").filter((l) => l.length > 0);
  expect(lines).toEqual([CANARY_CONSOLE, CANARY_FD, "follow-a-link: DONE [302,404,410,500,404,404,302,400]"]);

  for (const [what, value] of Object.entries(clicker)) {
    expect(output.includes(value), `the clicker's ${what} is in the service's output`).toBe(false);
    expect(dbBytes.includes(value), `the clicker's ${what} is in the database`).toBe(false);
  }
});
