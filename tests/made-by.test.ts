// Every link shows who made it (R-008). The first describe is the service half; the second is
// the CLI half: with no --by, the command sends $USER.
import { describe, expect, test } from "vitest";
import { EXIT } from "../src/cli.js";
import { apiCall, appWith } from "./support/app.js";
import { stack } from "./support/cli.js";

describe("R-008 made by", () => {
  test("R-008: a link made with made_by ana lists as ana, and reads as ana", async () => {
    const app = appWith();
    const made = await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/a", name: "q3-plan", made_by: "ana" });
    expect([made.statusCode, made.json().made_by]).toEqual([201, "ana"]);

    const list = await apiCall(app, "GET", "/-/api/links");
    expect(list.json().links.map((l: { name: string; made_by: string }) => [l.name, l.made_by])).toEqual([["q3-plan", "ana"]]);
    expect((await apiCall(app, "GET", "/-/api/links/q3-plan")).json().made_by).toBe("ana");
  });

  test("a link made with no made_by shows the empty string, not a name nobody gave", async () => {
    const app = appWith();
    await apiCall(app, "POST", "/-/api/links", { url: "https://example.com/a", name: "q3-plan" });
    expect((await apiCall(app, "GET", "/-/api/links/q3-plan")).json().made_by).toBe("");
  });
});

describe("R-008 made by, from the CLI", () => {
  /** What the command sent as made_by, in the one request `make` makes, and what the service then lists. */
  async function made(over: Record<string, string | undefined>, argv: string[], login?: () => string) {
    const { run } = await stack();
    const sent: { url: string; made_by?: string; name?: string }[] = [];
    const spy: typeof fetch = (input, init) => {
      if (typeof init?.body === "string") sent.push(JSON.parse(init.body));
      return fetch(input, init);
    };
    const ran = await run(["make", "https://example.com/a", "--name", "q3-plan", ...argv], over, {
      fetch: spy,
      ...(login === undefined ? {} : { login }),
    });
    const listed = JSON.parse((await run(["list", "--json"])).out).links as { made_by: string }[];
    return { ran, sent, listed: listed.map((l) => l.made_by) };
  }

  test("R-008: with no --by the CLI sends $USER, and the link lists as that user", async () => {
    const { ran, sent, listed } = await made({ USER: "ana" }, []);
    expect(ran.code).toBe(0);
    expect(sent).toEqual([{ url: "https://example.com/a", made_by: "ana", name: "q3-plan" }]);
    expect(listed).toEqual(["ana"]);
  });

  test("--by wins over $USER", async () => {
    const { sent, listed } = await made({ USER: "ana" }, ["--by", "the design team"]);
    expect(sent[0]!.made_by).toBe("the design team");
    expect(listed).toEqual(["the design team"]);
  });

  test("with no $USER, or an empty one, it sends the system's login name", async () => {
    for (const user of [undefined, "", "  "]) {
      const { sent, listed } = await made({ USER: user }, [], () => "sys-login");
      expect([user, sent[0]!.made_by, listed]).toEqual([user, "sys-login", ["sys-login"]]);
    }
  });

  test("with neither, it refuses to make a link nobody made, and sends nothing", async () => {
    for (const login of [
      () => "",
      () => {
        throw new Error("ENOENT: no such user");
      },
    ]) {
      const { ran, sent, listed } = await made({ USER: undefined }, [], login);
      expect(ran.code).toBe(EXIT.usage);
      expect(ran.err).toContain("pass --by <name>");
      expect([sent, listed]).toEqual([[], []]);
    }
  });
});
