// The built file, as npm links it into place: `dist/cli.js` run as a process, and R-015's own
// verify line run for real with `linkling` on PATH. An unbuilt tree is a red run here, never a
// pass; CI builds before it tests (.github/workflows/ci.yml).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EXIT } from "../src/cli.js";
import { seed } from "./support/app.js";
import { stack, type Ran } from "./support/cli.js";
import { TEST_KEY } from "./support/team-key.js";

const built = join(import.meta.dirname, "..", "dist", "cli.js");
let bin: string;

beforeAll(() => {
  if (!existsSync(built)) throw new Error("dist/cli.js is missing: run `npm run build` first (CI does)");
  // npm makes a package's bin executable when it links it; a fresh `tsc` output is not.
  chmodSync(built, 0o755);
  bin = mkdtempSync(join(tmpdir(), "linkling-bin-"));
  symlinkSync(built, join(bin, "linkling"));
});
afterAll(() => {
  if (bin !== undefined) rmSync(bin, { recursive: true, force: true });
});

/** Runs a command to its end, or fails the test after 20 s. */
function exec(command: string, args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} did not finish in 20 s`));
    }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** Runs the built file with the parent's end of one output pipe closed at once, as `| head -1` does to stdout. */
function exitWithClosedPipe(which: "stdout" | "stderr", args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [built, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    child[which].destroy();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the command did not finish in 20 s"));
    }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

const PATH = () => `${bin}:${process.env["PATH"]}`;

// The command R-015's verify line in products/linkling/REQUIREMENTS.md runs, character for character.
const R015 =
  "linkling make https://example.com/c --name cli-test && linkling list | grep -q cli-test && linkling edit cli-test https://example.com/d && linkling counts cli-test && linkling delete cli-test";

describe("dist/cli.js", () => {
  test("package.json's bin is this file, and it starts with the node shebang", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ linkling: "dist/cli.js" });
    expect(readFileSync(built, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  test("run as a process it prints its result and ends with the code the run ended with", async () => {
    const { app, base, env } = await stack();
    const processEnv = { PATH: PATH(), ...(env as Record<string, string>) };

    const made = await exec("linkling", ["make", "https://example.com/a", "--name", "p1"], processEnv);
    expect(made).toEqual({ code: 0, out: `${base}/p1\n`, err: "" });
    const listed = await exec("linkling", ["list", "--json"], processEnv);
    expect(JSON.parse(listed.out).links.map((l: { name: string }) => l.name)).toEqual(["p1"]);
    expect(app.links.list().map((l) => l.name)).toEqual(["p1"]);

    const wrongKey = await exec("linkling", ["list"], { ...processEnv, LINKLING_KEY: "not-the-team-key" });
    expect(wrongKey.code).toBe(EXIT.key);
    const usage = await exec("linkling", ["frobnicate"], processEnv);
    expect(usage.code).toBe(EXIT.usage);

    await app.close();
    const gone = await exec("linkling", ["list"], processEnv);
    expect(gone.code).toBe(EXIT.noAnswer);
    expect(gone.err).toContain("cannot reach");
  });

  test("a reader that closes the pipe early (| head -1) does not turn a run that worked into a failure", async () => {
    const { app, env } = await stack();
    const processEnv = env as Record<string, string>;
    // Nothing on stdout to lose: `list` of no links says so on stderr only.
    expect(await exitWithClosedPipe("stderr", ["list"], processEnv)).toBe(0);
    seed(app.links, "one", "https://example.com/a");
    expect(await exitWithClosedPipe("stdout", ["list"], processEnv)).toBe(0);
  });

  test("output that cannot be written is exit 70 with its own line, never the 1 that means the service said no", async () => {
    // `1</dev/null` opens stdout read-only, so writing to it fails with EBADF, not EPIPE.
    const ran = await exec("bash", ["-c", `"${process.execPath}" "${built}" --help 1</dev/null`], { PATH: PATH() });
    expect(ran.code).toBe(EXIT.bug);
    expect(ran.out).toBe("");
    expect(ran.err).toBe("linkling: cannot write output: EBADF\n");
  });

  test("R-015: the verify line, run under bash with linkling on PATH, exits 0 and does all five things", async () => {
    const { app, base, env } = await stack();
    const ran = await exec("bash", ["-o", "pipefail", "-c", R015], { PATH: PATH(), ...(env as Record<string, string>) });
    expect(ran.err).toBe("");
    // `list` went to grep; the other four commands printed these.
    expect(ran.out).toBe(`${base}/cli-test\n${base}/cli-test -> https://example.com/d\ncli-test: 0 total\ndeleted cli-test\n`);
    expect(ran.code).toBe(0);
    expect(app.links.list()).toEqual([]);
  });

  test("R-015: the same line against a service that is not there exits non-zero, and says why", async () => {
    const { app, env } = await stack();
    await app.close();
    const ran = await exec("bash", ["-o", "pipefail", "-c", R015], { PATH: PATH(), ...(env as Record<string, string>) });
    expect(ran.code).toBe(EXIT.noAnswer);
    expect(ran.out).toBe("");
    expect(ran.err).toContain("cannot reach");
  });

  test("a wrong key stops the line at its first command with the key's own exit code", async () => {
    const { app, env } = await stack();
    const ran = await exec("bash", ["-c", R015], { PATH: PATH(), ...(env as Record<string, string>), LINKLING_KEY: `${TEST_KEY}-no` });
    expect(ran.code).toBe(EXIT.key);
    expect(app.links.list()).toEqual([]);
  });
});
