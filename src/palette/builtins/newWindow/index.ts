/**
 * "New Window" palette entry (M9.3, spec §15).
 *
 * Group: Navigation. Matcher: always available.
 *
 * The panel spawns a new Tauri window on mount and closes the
 * palette. See NewWindowPanel for the actual work.
 */

import { registerPaneCommand } from "../../registry";
import { NewWindowPanel } from "./NewWindowPanel";

registerPaneCommand({
  name: "New Window",
  description: "Open a new Shax window with a fresh tab.",
  group: "Navigation",
  matcher: () => true,
  render: () => ({ kind: "panel", Panel: NewWindowPanel }),
});
