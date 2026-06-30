/**
 * Vitest browser-mode config — runs the `.browser.test.{ts,tsx}`
 * suite in a real Chromium via Playwright. The default jsdom
 * config in `vitest.config.ts` can't spin a real Web Worker, so
 * the worker-host integration tests live here.
 *
 * Run with: `pnpm test:browser`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.browser.test.{ts,tsx}"],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
