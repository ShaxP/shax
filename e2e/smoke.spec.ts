import { test, expect } from "@playwright/test";

test("app loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});

test("terminal pane is mounted in the DOM", async ({ page }) => {
  await page.goto("/");
  // The TerminalPane always renders this wrapper regardless of Tauri context.
  await expect(page.getByTestId("terminal-pane")).toBeVisible();
});

test("block list is rendered alongside the terminal", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("block-list")).toBeVisible();
  // No backend means no blocks; the empty-state hint must show.
  await expect(page.getByTestId("block-list-empty")).toBeVisible();
});
