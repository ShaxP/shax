/**
 * Viewer module — read-only CodeMirror 6 surface for inspecting
 * captured block bytes (slice 4.1), plus the Markdown and image
 * renderers stacked on it (slice 4.2).
 */

export { BlockViewerModal } from "./BlockViewerModal";
export type { BlockViewerModalProps } from "./BlockViewerModal";
export { Viewer } from "./Viewer";
export type { ViewerProps } from "./Viewer";
export { MarkdownView } from "./MarkdownView";
export type { MarkdownViewProps } from "./MarkdownView";
export { ImageView } from "./ImageView";
export type { ImageViewProps, ImageKind } from "./ImageView";
export { detectLanguage } from "./detectLanguage";
export type { LanguageId } from "./detectLanguage";
export { detectContentType } from "./detectContentType";
export type { ContentType } from "./detectContentType";
