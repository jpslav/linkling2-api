import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // dist/ holds the compiled build; a test file that reached it must never run a second time.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
