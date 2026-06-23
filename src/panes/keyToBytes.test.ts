/**
 * Unit tests for the keyboard-to-bytes mapper driving the M1.9
 * PromptStrip's input ownership.
 *
 * The mapper is a pure function over a structural subset of the browser
 * KeyboardEvent, so tests construct plain objects instead of real
 * KeyboardEvent instances.
 */

import { describe, it, expect } from "vitest";
import { keyToBytes } from "./keyToBytes";
import type { KeyMapInput } from "./keyToBytes";

function ev(overrides: Partial<KeyMapInput>): KeyMapInput {
  return {
    key: "",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("keyToBytes / printable", () => {
  it("sends a single ASCII char as its UTF-8 encoding", () => {
    expect(keyToBytes(ev({ key: "a" }))).toEqual(bytes("a"));
    expect(keyToBytes(ev({ key: "Z" }))).toEqual(bytes("Z"));
    expect(keyToBytes(ev({ key: " " }))).toEqual(bytes(" "));
    expect(keyToBytes(ev({ key: "!" }))).toEqual(bytes("!"));
  });

  it("sends a multibyte UTF-8 char as its bytes", () => {
    expect(keyToBytes(ev({ key: "é" }))).toEqual(bytes("é"));
    expect(keyToBytes(ev({ key: "✦" }))).toEqual(bytes("✦"));
  });
});

describe("keyToBytes / special keys", () => {
  it("Enter sends CR", () => {
    expect(keyToBytes(ev({ key: "Enter" }))).toEqual(new Uint8Array([0x0d]));
  });

  it("Backspace sends DEL (0x7f), not BS (0x08)", () => {
    expect(keyToBytes(ev({ key: "Backspace" }))).toEqual(new Uint8Array([0x7f]));
  });

  it("Tab sends TAB", () => {
    expect(keyToBytes(ev({ key: "Tab" }))).toEqual(new Uint8Array([0x09]));
  });

  it("Escape sends ESC", () => {
    expect(keyToBytes(ev({ key: "Escape" }))).toEqual(new Uint8Array([0x1b]));
  });

  it("Arrow keys send the standard CSI sequences", () => {
    expect(keyToBytes(ev({ key: "ArrowUp" }))).toEqual(bytes("\x1b[A"));
    expect(keyToBytes(ev({ key: "ArrowDown" }))).toEqual(bytes("\x1b[B"));
    expect(keyToBytes(ev({ key: "ArrowRight" }))).toEqual(bytes("\x1b[C"));
    expect(keyToBytes(ev({ key: "ArrowLeft" }))).toEqual(bytes("\x1b[D"));
  });

  it("Home / End / Delete / Insert / PageUp / PageDown send standard sequences", () => {
    expect(keyToBytes(ev({ key: "Home" }))).toEqual(bytes("\x1b[H"));
    expect(keyToBytes(ev({ key: "End" }))).toEqual(bytes("\x1b[F"));
    expect(keyToBytes(ev({ key: "Delete" }))).toEqual(bytes("\x1b[3~"));
    expect(keyToBytes(ev({ key: "Insert" }))).toEqual(bytes("\x1b[2~"));
    expect(keyToBytes(ev({ key: "PageUp" }))).toEqual(bytes("\x1b[5~"));
    expect(keyToBytes(ev({ key: "PageDown" }))).toEqual(bytes("\x1b[6~"));
  });

  it("F1-F4 send the standard SS3 sequences", () => {
    expect(keyToBytes(ev({ key: "F1" }))).toEqual(bytes("\x1bOP"));
    expect(keyToBytes(ev({ key: "F2" }))).toEqual(bytes("\x1bOQ"));
    expect(keyToBytes(ev({ key: "F3" }))).toEqual(bytes("\x1bOR"));
    expect(keyToBytes(ev({ key: "F4" }))).toEqual(bytes("\x1bOS"));
  });
});

describe("keyToBytes / Ctrl shortcuts", () => {
  it("Ctrl+letter sends the C0 control byte", () => {
    expect(keyToBytes(ev({ key: "a", ctrlKey: true }))).toEqual(new Uint8Array([0x01]));
    expect(keyToBytes(ev({ key: "c", ctrlKey: true }))).toEqual(new Uint8Array([0x03]));
    expect(keyToBytes(ev({ key: "d", ctrlKey: true }))).toEqual(new Uint8Array([0x04]));
    expect(keyToBytes(ev({ key: "r", ctrlKey: true }))).toEqual(new Uint8Array([0x12]));
    expect(keyToBytes(ev({ key: "u", ctrlKey: true }))).toEqual(new Uint8Array([0x15]));
    expect(keyToBytes(ev({ key: "z", ctrlKey: true }))).toEqual(new Uint8Array([0x1a]));
  });

  it("Ctrl+letter is case-insensitive (Shift on or off)", () => {
    expect(keyToBytes(ev({ key: "C", ctrlKey: true, shiftKey: true }))).toEqual(
      new Uint8Array([0x03]),
    );
  });

  it("Ctrl+Space sends NUL", () => {
    expect(keyToBytes(ev({ key: " ", ctrlKey: true }))).toEqual(new Uint8Array([0x00]));
  });

  it("Ctrl+[ sends ESC", () => {
    expect(keyToBytes(ev({ key: "[", ctrlKey: true }))).toEqual(new Uint8Array([0x1b]));
  });
});

describe("keyToBytes / Alt shortcuts", () => {
  it("Alt+letter sends ESC followed by the letter", () => {
    expect(keyToBytes(ev({ key: "b", altKey: true }))).toEqual(new Uint8Array([0x1b, 0x62]));
    expect(keyToBytes(ev({ key: "f", altKey: true }))).toEqual(new Uint8Array([0x1b, 0x66]));
  });
});

describe("keyToBytes / ignored events", () => {
  it("modifier-only events return null", () => {
    expect(keyToBytes(ev({ key: "Shift", shiftKey: true }))).toBeNull();
    expect(keyToBytes(ev({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(keyToBytes(ev({ key: "Alt", altKey: true }))).toBeNull();
    expect(keyToBytes(ev({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("Cmd/Win shortcuts return null so the host can handle them", () => {
    expect(keyToBytes(ev({ key: "c", metaKey: true }))).toBeNull();
    expect(keyToBytes(ev({ key: "v", metaKey: true }))).toBeNull();
  });

  it("Unidentified / Dead keys return null", () => {
    expect(keyToBytes(ev({ key: "Unidentified" }))).toBeNull();
    expect(keyToBytes(ev({ key: "Dead" }))).toBeNull();
  });

  it("Unmapped multi-char keys return null", () => {
    expect(keyToBytes(ev({ key: "ScrollLock" }))).toBeNull();
    expect(keyToBytes(ev({ key: "F12" }))).toBeNull();
  });
});
