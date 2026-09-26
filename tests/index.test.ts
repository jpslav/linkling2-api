import { expect, test } from "vitest";
import { serviceName } from "../src/index.js";

test("serviceName names the service", () => {
  expect(serviceName()).toBe("deliberately-wrong");
});
