/**
 * "Reload community commands" palette entry (M8.5 spec §14).
 *
 * Development workflow: after editing a manifest / command.js
 * under `~/.config/shax/commands/`, run this to re-scan the
 * disk without restarting the app.
 *
 * Group: Debug. Matcher: always available.
 */

import { registerPaneCommand } from "../../registry";
import { ReloadPanel } from "./ReloadPanel";

registerPaneCommand({
  name: "Reload community commands",
  description: "Re-scan ~/.config/shax/commands/ and re-register add-ons.",
  group: "Debug",
  matcher: () => true,
  render: () => ({ kind: "panel", Panel: ReloadPanel }),
});
