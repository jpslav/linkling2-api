// Every link shows who made it (R-008). This file is the service half; the CLI half
// (no --by sends $USER) is LL-002's, and belongs in this file too.
import { describe, expect, test } from "vitest";
import { apiCall, appWith } from "./support/app.js";

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
