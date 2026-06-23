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

test("chrome (title bar, pane area, statusline) is rendered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("title-bar")).toBeVisible();
  await expect(page.getByTestId("pane-area")).toBeVisible();
  await expect(page.getByTestId("statusline")).toBeVisible();
});

test("an initial tab is open with the default label", async ({ page }) => {
  await page.goto("/");
  // M2 slice 2.1: one tab on launch, labelled `shax` until a real cwd
  // comes in via OSC 133 A. The + button is the affordance for opening
  // more.
  const tabs = page.getByTestId("title-tab");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText("shax");
  await expect(page.getByTestId("title-new-tab")).toBeVisible();
});
