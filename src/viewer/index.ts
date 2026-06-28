/**
 * Viewer module — read-only CodeMirror 6 surface for inspecting
 * captured block bytes. Slice 4.1 sets up the rendering plumbing;
 * the formatter system in 4.3 lights up `cat` / `bat` autoroutes.
 */

export { BlockViewerModal } from "./BlockViewerModal";
export type { BlockViewerModalProps } from "./BlockViewerModal";
export { Viewer } from "./Viewer";
export type { ViewerProps } from "./Viewer";
export { detectLanguage } from "./detectLanguage";
export type { LanguageId } from "./detectLanguage";
