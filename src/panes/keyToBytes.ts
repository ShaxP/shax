/**
 * Map a browser KeyboardEvent into the byte sequence the PTY expects.
 *
 * This is a minimal port of xterm.js's keyboard handler — just enough to
 * drive the M1.9 PromptStrip when it owns input. The mapping follows the
 * common DEC/xterm convention shells expect:
 *
 *  - Printable single chars are sent as-is (UTF-8 encoded).
 *  - Special keys (Enter, Backspace, Tab, arrows, etc.) are sent as their
 *    standard VT/xterm escape sequences.
 *  - Ctrl + letter is sent as the corresponding C0 control byte.
 *  - Alt + key is sent as ESC followed by the key (the "meta prefix"
 *    convention readline and most shells expect).
 *
 * Modifier-only events (just Shift / Ctrl / Alt / Meta with no key) return
 * null so the caller can skip them without sending stray bytes. Keys that
 * we don't yet handle (F-keys past F4, browser shortcuts, etc.) also
 * return null; we can extend the table when the need arises.
 *
 * This module is pure: takes an event-shaped argument (just the relevant
 * fields), returns bytes. It's unit-testable without a DOM.
 */

const ENCODER = new TextEncoder();

/**
 * The subset of KeyboardEvent we read. Taking a structural type lets tests
 * pass plain objects without constructing real KeyboardEvent instances.
 */
export interface KeyMapInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Returns the bytes to send to the PTY for this key event, or `null` if
 * the event should be ignored (modifier-only, unmapped function key, etc).
 */
export function keyToBytes(e: KeyMapInput): Uint8Array | null {
  // Pure modifier presses (Shift, Ctrl, Alt, Meta with no other key)
  // arrive as `key === "Shift"` etc. — never something to send.
  if (
    e.key === "Shift" ||
    e.key === "Control" ||
    e.key === "Alt" ||
    e.key === "Meta" ||
    e.key === "CapsLock" ||
    e.key === "Dead" ||
    e.key === "Unidentified"
  ) {
    return null;
  }

  // Cmd / Win shortcuts (copy, paste, etc.) belong to the host, not the
  // shell. Letting them through here would double-fire most actions.
  if (e.metaKey) {
    return null;
  }

  // Named special keys before any single-char heuristic so that, for
  // example, ArrowLeft is never mistaken for a printable.
  switch (e.key) {
    case "Enter":
      return new Uint8Array([0x0d]);
    case "Tab":
      return new Uint8Array([0x09]);
    case "Backspace":
      // Send DEL (0x7f) — what every modern terminal sends. The classic
      // BS (0x08) is reserved for the shell's own readline keybindings.
      return new Uint8Array([0x7f]);
    case "Escape":
      return new Uint8Array([0x1b]);
    case "ArrowUp":
      return ENCODER.encode("\x1b[A");
    case "ArrowDown":
      return ENCODER.encode("\x1b[B");
    case "ArrowRight":
      return ENCODER.encode("\x1b[C");
    case "ArrowLeft":
      return ENCODER.encode("\x1b[D");
    case "Home":
      return ENCODER.encode("\x1b[H");
    case "End":
      return ENCODER.encode("\x1b[F");
    case "Delete":
      return ENCODER.encode("\x1b[3~");
    case "Insert":
      return ENCODER.encode("\x1b[2~");
    case "PageUp":
      return ENCODER.encode("\x1b[5~");
    case "PageDown":
      return ENCODER.encode("\x1b[6~");
    case "F1":
      return ENCODER.encode("\x1bOP");
    case "F2":
      return ENCODER.encode("\x1bOQ");
    case "F3":
      return ENCODER.encode("\x1bOR");
    case "F4":
      return ENCODER.encode("\x1bOS");
  }

  // Ctrl + letter → C0 control byte (Ctrl-A = 0x01 … Ctrl-Z = 0x1a).
  if (e.ctrlKey && e.key.length === 1) {
    const lower = e.key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      const code = lower.charCodeAt(0) - "a".charCodeAt(0) + 1;
      return new Uint8Array([code]);
    }
    // Ctrl+Space → NUL, Ctrl+@ → NUL: shells use NUL for "set mark".
    if (e.key === " " || e.key === "@") {
      return new Uint8Array([0x00]);
    }
    // Ctrl+[ → ESC (same as Escape key); Ctrl+\\ → FS (0x1c); etc. The
    // most common (Ctrl+C, Ctrl+D, Ctrl+L, Ctrl+W, Ctrl+U, Ctrl+R) are
    // already covered by the letter range above.
    if (e.key === "[") return new Uint8Array([0x1b]);
    if (e.key === "\\") return new Uint8Array([0x1c]);
    if (e.key === "]") return new Uint8Array([0x1d]);
  }

  // Alt + key → ESC prefix + the key, the "meta prefix" convention
  // readline / emacs / bash understand. Only applies to single-char keys
  // we know how to encode.
  if (e.altKey && e.key.length === 1) {
    const bytes = ENCODER.encode(e.key);
    const out = new Uint8Array(bytes.length + 1);
    out[0] = 0x1b;
    out.set(bytes, 1);
    return out;
  }

  // Plain printable single characters (letters, digits, punctuation, and
  // any UTF-8 character a dead-key sequence resolved to).
  if (e.key.length === 1) {
    return ENCODER.encode(e.key);
  }

  // Anything we haven't mapped: ignore. The handler can fall back to
  // letting the browser's default behaviour run.
  return null;
}
