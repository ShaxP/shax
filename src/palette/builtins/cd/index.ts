/**
 * `cd to directory` — first real M8 built-in.
 *
 * Available in every pane (`cd` works everywhere, not just
 * inside a git repo). Opens the file-browser panel; on submit
 * the panel returns `cd <absolute-path>` and the palette host
 * writes it to the prompt.
 */

import { registerPaneCommand } from "../../registry";
import { CdPanel } from "./CdPanel";

registerPaneCommand({
  name: "cd to directory",
  description: "Browse the filesystem and switch into a directory.",
  group: "Navigation",
  matcher: () => true,
  render: () => ({ kind: "panel", Panel: CdPanel }),
});
