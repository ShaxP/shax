/**
 * Sidebar end-to-end (M13, spec §19).
 *
 * Scope note — read before adding to this file. Playwright drives the
 * Vite dev server in a plain browser, with no Tauri host behind it, so
 * every backend call short-circuits: `powerKeepAwake` resolves `false`
 * because there is no OS here to keep awake. Whether the assertion is
 * actually granted is therefore NOT verifiable at this layer — that
 * belongs to `power.rs`'s Rust tests, which exercise the real
 * acquire/release against the host OS.
 *
 * What this file covers is the sidebar chrome, the toggle, and the
 * half of the contract that a backendless harness proves better than
 * any other: the widget adopts what the backend grants and nothing
 * else, so with nothing granted it stays off.
 */

import { test, expect } from "@playwright/test";

test("sidebar renders as an icon rail by default", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toBeVisible();
  // First-run default is the 44px rail (spec §19 D2).
  await expect(sidebar).toHaveAttribute("data-visible", "false");
});

test("the chevron expands and collapses the sidebar", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByTestId("sidebar");
  await page.getByTestId("sidebar-toggle").click();
  await expect(sidebar).toHaveAttribute("data-visible", "true");
  await expect(page.getByTestId("sidebar-clock")).toBeVisible();

  await page.getByTestId("sidebar-toggle").click();
  await expect(sidebar).toHaveAttribute("data-visible", "false");
});

test("the caffeinate widget renders in the expanded sidebar", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar-caffeinate")).toBeVisible();
  await expect(page.getByTestId("sidebar-caffeinate-switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("caffeinate stays off when the backend grants nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sidebar-toggle").click();
  const toggle = page.getByTestId("sidebar-caffeinate-switch");
  await toggle.click();
  // With no Tauri host there is no OS to hold an assertion. The widget
  // must stay off: its state is whatever the backend granted, never
  // the click that asked for it.
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("sidebar-caffeinate-duration")).toHaveCount(0);
});
