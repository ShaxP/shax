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

test("M1.5 chrome (title bar, pane area, statusline) is rendered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("title-bar")).toBeVisible();
  await expect(page.getByTestId("pane-area")).toBeVisible();
  await expect(page.getByTestId("statusline")).toBeVisible();
  // Active tab pill carries the default tab label and a neutral cwd
  // fallback before the first OSC 133 A arrives.
  await expect(page.getByTestId("active-tab")).toContainText("shax");
});
