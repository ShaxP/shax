import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // Browser-mode suites (real Chromium via Playwright) live
    // in `*.browser.test.{ts,tsx}` and are picked up by
    // `vitest.config.browser.ts`. Exclude here so they don't
    // fail in jsdom.
    exclude: ["**/*.browser.test.{ts,tsx}", "node_modules/**", "dist/**"],
  },
});
