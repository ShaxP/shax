/**
 * "Sidebar: expand / collapse" palette entry (M13.1, spec §19 D2).
 *
 * Group: Navigation. Matcher: always available.
 *
 * Mirrors ⌘B and the sidebar's chevron button — dispatches
 * `shax:toggle-sidebar` and closes the palette. The App-level
 * listener flips the sidebar-visible state.
 */

import { registerPaneCommand } from "../../registry";
import { SidebarTogglePanel } from "./SidebarTogglePanel";

registerPaneCommand({
  name: "Sidebar: expand / collapse",
  description: "Toggle the sidebar between the icon rail and the expanded view.",
  group: "Navigation",
  matcher: () => true,
  render: () => ({ kind: "panel", Panel: SidebarTogglePanel }),
});
