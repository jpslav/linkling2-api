#!/usr/bin/env node
// The `linkling` command: make, list, edit, delete and count links through the team API
// (ADR-0013), from a terminal. It is this package's `bin`, installed with `npm install -g`
// (ADR-0007, ADR-0016).
//
// It imports only `node:` modules and `keyProblem`, which itself imports only `node:crypto`,
// so starting it never loads Fastify or better-sqlite3 (tests/cli.test.ts, "loads only node:
// modules", walks the imports).
// It does not validate a name, an expiry or a URL: they go to the API as given, and the API's own
// sentence is what the user reads. What it checks is its own environment and arguments.
import { userInfo } from "node:os";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { keyProblem } from "./team-key.js";

/** What a run of the command ends with. Scripts, and demo.sh, rely on these (ADR-0016). */
export const EXIT = {
  ok: 0,
  /** The service understood the request and said no: a taken name, no such link, a bad value. */
  refused: 1,
  /** The command line or the environment is wrong; nothing was sent. */
  usage: 2,
  /** The service refused the team key (401). */
  key: 3,
  /** No usable answer: unreachable, silent, a redirect, a 5xx, or not Linkling's API. */
  noAnswer: 4,
  /** A bug in this command, or output it cannot write: never anything the service said or did. */
  bug: 70,
} as const;

/** How long a request may take, whole, before it is given up on. */
export const TIMEOUT_MS = 10_000;

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The global `fetch` unless a test swaps it. */
  fetch?: typeof fetch;
  /** The system's login name for whoever is running this, for when `$USER` is not set. */
  login?: () => string;
  /** How long a request may take, whole; TIMEOUT_MS unless a test shortens it. */
  timeoutMs?: number;
}

class Failure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const usageError = (message: string): Failure => new Failure(EXIT.usage, message);

const USAGE = `usage: linkling <command> [options]

  make <url> [--name <name>] [--expires <date|lifetime>] [--by <name>]
                        makes a short link and prints it
  list                  lists every link, newest first
  edit <name> <url>     changes where a link points
  delete <name>         deletes a link
  counts <name>         shows a link's followed count for each UTC day

  --expires takes a date such as 2026-12-31 (to the end of that UTC day) or a lifetime such as
  7d, 36h, 90m or 30s. Without --by, a link is made by $USER, or by your login name when that is not set.
  --json, on any command, prints the service's answer as one line of JSON.

environment:
  LINKLING_BASE   where the service answers, such as http://localhost:8080
  LINKLING_KEY    the team key

exit codes: 0 done, 1 the service said no, 2 wrong command line or environment,
3 the key was refused, 4 no usable answer, 70 a bug in linkling itself or output it cannot write
`;

/** What each command takes: its positional arguments, in order, and its string options. */
const COMMANDS = {
  make: { positionals: ["url"], strings: ["name", "expires", "by"] },
  list: { positionals: [], strings: [] },
  edit: { positionals: ["name", "url"], strings: [] },
  delete: { positionals: ["name"], strings: [] },
  counts: { positionals: ["name"], strings: [] },
} as const;
type CommandName = keyof typeof COMMANDS;
const isCommand = (word: string): word is CommandName => Object.hasOwn(COMMANDS, word);

interface Settings {
  /** The service's origin, with no trailing slash. */
  base: string;
  key: string;
  fetch: typeof fetch;
  timeoutMs: number;
}

/** LINKLING_BASE and LINKLING_KEY, or the usage error saying which is wrong. */
export function settings(io: CliIo): Settings {
  const given = io.env["LINKLING_BASE"];
  if (given === undefined || given === "") {
    throw usageError("LINKLING_BASE is not set; set it to where the service answers, such as http://localhost:8080");
  }
  // The value is not echoed: an address can carry a password.
  const rule = "LINKLING_BASE must be an http or https address with no path, such as http://localhost:8080";
  if (!URL.canParse(given)) throw usageError(rule);
  const url = new URL(given);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.href !== `${url.origin}/`) throw usageError(rule);
  const key = io.env["LINKLING_KEY"];
  const problem = keyProblem(key);
  if (key === undefined || problem !== null) throw usageError(`LINKLING_KEY ${problem ?? "is not set"}`);
  return { base: url.origin, key, fetch: io.fetch ?? globalThis.fetch, timeoutMs: io.timeoutMs ?? TIMEOUT_MS };
}

/** Who a link is made by (R-008): --by, else $USER, else the system's login name. */
function madeBy(io: CliIo, by: string | undefined): string {
  if (by !== undefined) {
    if (by.trim() === "") throw usageError("--by needs a name");
    return by;
  }
  const user = io.env["USER"];
  if (user !== undefined && user.trim() !== "") return user;
  try {
    const login = (io.login ?? (() => userInfo().username))();
    if (login.trim() !== "") return login;
  } catch {
    // os.userInfo() throws "if a user has no username or homedir" (nodejs.org/api/os.html): no name.
  }
  throw usageError("cannot tell who you are (USER is not set and the system has no login name for you); pass --by <name>");
}

/** Why a request got no answer, in a few words. */
function reason(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === "TimeoutError") return `no answer within ${timeoutMs / 1000} s`;
  const cause = (err instanceof Error ? err.cause : undefined) as
    | { code?: string; errors?: { code?: string }[]; message?: string }
    | undefined;
  // `fetch failed` says nothing; the cause does, even without a code (`bad port` for a port fetch refuses).
  const said = err instanceof Error ? err.message : String(err);
  return cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message ?? said;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A link as the API shows it (ADR-0013), checked only as far as this command reads it. */
interface LinkJson {
  name: string;
  url: string;
  made_by: string;
  expires_at: string | null;
  expired: boolean;
}
const isLink = (value: unknown): value is LinkJson =>
  isObject(value) &&
  typeof value["name"] === "string" &&
  typeof value["url"] === "string" &&
  typeof value["made_by"] === "string" &&
  (value["expires_at"] === null || typeof value["expires_at"] === "string") &&
  typeof value["expired"] === "boolean";

interface CountsJson {
  name: string;
  total: number;
  days: { day: string; count: number }[];
}
const isCounts = (value: unknown): value is CountsJson =>
  isObject(value) &&
  typeof value["name"] === "string" &&
  typeof value["total"] === "number" &&
  Array.isArray(value["days"]) &&
  value["days"].every((d) => isObject(d) && typeof d["day"] === "string" && typeof d["count"] === "number");

const notLinkling = (base: string, status: number): Failure =>
  new Failure(EXIT.noAnswer, `${base} answered ${status}, but not the way Linkling's API does; is LINKLING_BASE right?`);

/**
 * One request. Returns the parsed JSON body (undefined for a 204) of an answer with status
 * `expect`; anything else is the Failure that says why, with the exit code that goes with it.
 */
async function call(s: Settings, method: string, path: string, expect: 200 | 201 | 204, body?: unknown): Promise<unknown> {
  let status: number;
  let text: string;
  try {
    const res = await s.fetch(`${s.base}${path}`, {
      method,
      // A redirect is reported, never followed: fetch answers a POST's 301 or 302 with a GET.
      redirect: "manual",
      signal: AbortSignal.timeout(s.timeoutMs),
      headers: {
        authorization: `Bearer ${s.key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw new Failure(EXIT.noAnswer, `cannot reach ${s.base}: ${reason(err, s.timeoutMs)}`);
  }
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (status >= 300 && status < 400) {
    throw new Failure(
      EXIT.noAnswer,
      `${s.base} answered ${status}, which Linkling's API never sends; if it is redirecting, set LINKLING_BASE to where it redirects to`,
    );
  }
  if (status === 401) throw new Failure(EXIT.key, "the service refused LINKLING_KEY (401); check the team key");
  if (status === expect) {
    if (expect === 204 || json !== undefined) return json;
    throw notLinkling(s.base, status);
  }
  // Only the API's own answer, exactly `{"error": "..."}` (ADR-0013), is the service speaking. Any
  // other body, even JSON with an `error` field, is some other server: a stock Fastify 404 has one.
  const said = isObject(json) && Object.keys(json).length === 1 && typeof json["error"] === "string" ? json["error"] : null;
  if (said === null) throw notLinkling(s.base, status);
  throw new Failure(status >= 400 && status < 500 ? EXIT.refused : EXIT.noAnswer, `${said} (${status})`);
}

// Roughly how many terminal columns a cell takes: East Asian wide and fullwidth characters (the
// Hangul, CJK and fullwidth ranges below) and emoji shown as pictures take two, and combining
// marks and format characters such as the zero-width joiner take none. A made-by name can hold
// any of them (ADR-0013), and a cell's length in characters is not its width on screen.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const NO_WIDTH = /[\p{M}\p{Cf}]/u;
const columns = (text: string): number =>
  [...text].reduce((sum, char) => sum + (NO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1), 0);

/** Left-aligned columns, two spaces apart; the last is never padded, so a long URL stays whole. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => columns(row[i]!))));
  const line = (row: string[]): string =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i]! - columns(cell)))).join("  ");
  return rows.map((row) => `${line(row)}\n`).join("");
}

/** `never` for a link with no expiry (R-006), and `expired` in front of a time that has passed. */
const expiryText = (link: LinkJson): string =>
  link.expires_at === null ? "never" : link.expired ? `expired ${link.expires_at}` : link.expires_at;

const linkPath = (name: string): string => {
  // `.` and `..` are dot segments: they would leave /-/api/links/ for another route.
  if (name === "." || name === "..") throw usageError(`"${name}" is not a link name`);
  return `/-/api/links/${encodeURIComponent(name)}`;
};

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [word, ...rest] = argv;
  if (word === undefined) throw usageError(`no command given\n\n${USAGE.trimEnd()}`);
  if (word === "help" || word === "--help" || word === "-h") {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (!isCommand(word)) throw usageError(`unknown command "${word}"\n\n${USAGE.trimEnd()}`);
  const spec = COMMANDS[word];

  const options: ParseArgsOptionsConfig = { json: { type: "boolean" }, help: { type: "boolean", short: "h" } };
  for (const name of spec.strings) options[name] = { type: "string" };
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError(`${word}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;
  if (values["help"] === true) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (positionals.length !== spec.positionals.length) {
    const wants = spec.positionals.map((p) => `<${p}>`).join(" ");
    throw usageError(`${word} takes ${wants === "" ? "no arguments" : wants}, and was given ${positionals.length}`);
  }
  const json = values["json"] === true;
  const text = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === "string" ? value : undefined;
  };
  const arg = (i: number): string => positionals[i]!;
  const printJson = (body: unknown): void => io.stdout(`${JSON.stringify(body)}\n`);

  const s = settings(io);
  const shortLink = (link: LinkJson): string => `${s.base}/${link.name}`;
  const linkFrom = (answer: unknown, status: number): LinkJson => {
    if (!isLink(answer)) throw notLinkling(s.base, status);
    return answer;
  };

  switch (word) {
    case "make": {
      const body: Record<string, string> = { url: arg(0), made_by: madeBy(io, text("by")) };
      const name = text("name");
      const expires = text("expires");
      if (name !== undefined) body["name"] = name;
      if (expires !== undefined) body["expires"] = expires;
      const answer = await call(s, "POST", "/-/api/links", 201, body);
      const link = linkFrom(answer, 201);
      if (json) printJson(answer);
      else io.stdout(`${shortLink(link)}\n`);
      return EXIT.ok;
    }
    case "list": {
      const answer = await call(s, "GET", "/-/api/links", 200);
      const links = isObject(answer) ? answer["links"] : undefined;
      if (!Array.isArray(links) || !links.every(isLink)) throw notLinkling(s.base, 200);
      if (json) printJson(answer);
      else if (links.length === 0) io.stderr("no links yet\n");
      else {
        const rows = links.map((link) => [link.name, link.made_by === "" ? "-" : link.made_by, expiryText(link), link.url]);
        io.stdout(table([["NAME", "MADE BY", "EXPIRES", "TARGET"], ...rows]));
      }
      return EXIT.ok;
    }
    case "edit": {
      const answer = await call(s, "PATCH", linkPath(arg(0)), 200, { url: arg(1) });
      const link = linkFrom(answer, 200);
      if (json) printJson(answer);
      else io.stdout(`${shortLink(link)} -> ${link.url}\n`);
      // The API answers 200 for an expired link, and editing it does not revive it.
      if (link.expired) io.stderr(`linkling: note: ${link.name} has expired; changing its target does not bring it back\n`);
      return EXIT.ok;
    }
    case "delete": {
      await call(s, "DELETE", linkPath(arg(0)), 204);
      if (json) printJson({ name: arg(0), deleted: true });
      else io.stdout(`deleted ${arg(0)}\n`);
      return EXIT.ok;
    }
    case "counts": {
      const answer = await call(s, "GET", `${linkPath(arg(0))}/counts`, 200);
      if (!isCounts(answer)) throw notLinkling(s.base, 200);
      if (json) printJson(answer);
      else io.stdout(`${answer.name}: ${answer.total} total\n${answer.days.map((d) => `${d.day}  ${d.count}\n`).join("")}`);
      return EXIT.ok;
    }
  }
}

/**
 * Runs the command and returns its exit code. It does not exit the process and does not throw: a
 * refusal is a code, a bug is 70, and a line it cannot write to stderr is left unsaid.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const say = (line: string): void => {
    try {
      io.stderr(line);
    } catch {
      // Whatever broke is the output itself; there is nothing left to say it on.
    }
  };
  try {
    return await run(argv, io);
  } catch (err) {
    if (err instanceof Failure) {
      say(`linkling: ${err.message}\n`);
      return err.code;
    }
    say(`linkling: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.bug;
  }
}

if (import.meta.main) {
  // `linkling list | head -1` closes the pipe early; that is the reader's choice, not an error, and
  // the same goes for a closed stderr. Any other failure to write (stdout opened read-only, say) is
  // ours, never the service saying no: exit 70, not the 1 an uncaught error would end with.
  let unwritable = false;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") return;
      unwritable = true;
      process.exitCode = EXIT.bug;
      if (stream === process.stdout) process.stderr.write(`linkling: cannot write output: ${err.code ?? err.message}\n`);
    });
  }
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  });
  process.exitCode = unwritable ? EXIT.bug : code;
}
