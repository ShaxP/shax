/**
 * Metadata view shape (M4.5 slice 2 — INFO lens).
 *
 * INFO renders one or more titled *sections*, each a list of
 * key / value rows. Universal `FILE` stats are always the top
 * section for cat / bat blocks with a filename argument.
 * Format-specific parsers (PNG, JPEG, GIF, …) append their
 * own sections when they detect a match on the file's magic
 * bytes.
 *
 * Deliberately simple: no nesting, no inline rich content, no
 * per-row styling. If a format needs richer INFO in future, we
 * add it here — but the current bar is "the user learns things
 * they'd otherwise reach for `stat` / `identify` / `exiftool`
 * to answer."
 */

export interface MetadataRow {
  readonly key: string;
  readonly value: string;
  /** Optional muted label appended after the value in the same
   *  row — used e.g. for a colour swatch or a raw byte count
   *  next to a human-friendly size (`"290,824 bytes"`). */
  readonly hint?: string;
}

export interface MetadataSection {
  readonly title: string;
  readonly rows: readonly MetadataRow[];
}

export type MetadataView = readonly MetadataSection[];
