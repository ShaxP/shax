/**
 * Focused tests for the M7.5b preferences reshape. The modal has grown
 * a left-nav layout, a keychain-reassurance strip, and a bottom status
 * bar; these tests exercise the visible surface without going through
 * App-level plumbing.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { SettingsModal } from "./SettingsModal";
import type { AppearancePreferences } from "../theme/preferences";

// ── Mocks ──────────────────────────────────────────────────────────────

const mockGetAssistantConfig = vi.fn();
const mockSetAssistantConfig = vi.fn();
const mockProbeClaudeCli = vi.fn();
const mockHasClaudeApiKey = vi.fn();
const mockSetClaudeApiKey = vi.fn();
const mockDeleteClaudeApiKey = vi.fn();
const mockProbeOllama = vi.fn();
const mockProbeOllamaModel = vi.fn();
const mockLoadPreferences = vi.fn();
const mockSavePreferences = vi.fn();
const mockListThemes = vi.fn();

vi.mock("./config", () => ({
  getAssistantConfig: (): Promise<unknown> => mockGetAssistantConfig() as Promise<unknown>,
  setAssistantConfig: (cfg: unknown): Promise<unknown> =>
    mockSetAssistantConfig(cfg) as Promise<unknown>,
}));

vi.mock("../assistant/providers/claude/apiKey", () => ({
  hasClaudeApiKey: (): Promise<boolean> => mockHasClaudeApiKey() as Promise<boolean>,
  setClaudeApiKey: (key: string): Promise<void> => mockSetClaudeApiKey(key) as Promise<void>,
  deleteClaudeApiKey: (): Promise<void> => mockDeleteClaudeApiKey() as Promise<void>,
}));

vi.mock("../assistant/providers/claude/subscription", () => ({
  probeClaudeCli: (): Promise<string | null> => mockProbeClaudeCli() as Promise<string | null>,
}));

vi.mock("../assistant/providers/ollama/ollama", () => ({
  probeOllama: (): Promise<unknown> => mockProbeOllama() as Promise<unknown>,
  probeOllamaModel: (model: string): Promise<unknown> =>
    mockProbeOllamaModel(model) as Promise<unknown>,
}));

vi.mock("../theme/preferences", async () => {
  // Import the real module so we can spread its constants
  // (DEFAULT_APPEARANCE, MIN/MAX_FONT_SIZE, ...) through to
  // the component while still stubbing the async IO.
  const actual =
    await vi.importActual<typeof import("../theme/preferences")>("../theme/preferences");
  return {
    ...actual,
    loadPreferences: (): Promise<unknown> => mockLoadPreferences() as Promise<unknown>,
    savePreferences: (p: unknown): Promise<unknown> => mockSavePreferences(p) as Promise<unknown>,
  };
});

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  return {
    ...actual,
    listThemes: (): Promise<unknown> => mockListThemes() as Promise<unknown>,
  };
});

const DEFAULT_CONFIG = {
  provider: "",
  claude_lane: "none",
  claude_model: null,
  ollama_model: null,
  ollama_capabilities: null,
};

const OLLAMA_REACHABLE = {
  reachable: true,
  models: ["llama3.1", "qwen2.5"],
  error: null,
};

beforeEach(() => {
  mockGetAssistantConfig.mockResolvedValue(DEFAULT_CONFIG);
  mockSetAssistantConfig.mockResolvedValue(undefined);
  mockProbeClaudeCli.mockResolvedValue(null);
  mockHasClaudeApiKey.mockResolvedValue(false);
  mockSetClaudeApiKey.mockResolvedValue(undefined);
  mockDeleteClaudeApiKey.mockResolvedValue(undefined);
  mockProbeOllama.mockResolvedValue({ reachable: false, models: [], error: null });
  mockProbeOllamaModel.mockResolvedValue({ tools: true, vision: false, unknown: false });
  mockLoadPreferences.mockResolvedValue({
    theme: "system",
    assistant_docked: false,
    assistant_dock_width: 420,
    appearance: {
      theme_light: "shax-light",
      theme_dark: "shax-dark",
      font_family: null,
      font_size: 13,
      ligatures: true,
    },
  });
  mockSavePreferences.mockResolvedValue(undefined);
  mockListThemes.mockResolvedValue([
    {
      id: "shax-dark",
      name: "Shax Dark",
      mode: "dark",
      source: "test",
      license: "MIT",
      chrome: {},
      terminal: {
        foreground: "#fff",
        background: "#000",
        cursor: "#fff",
        selectionBackground: "#333",
        ansi: {
          black: "#000",
          red: "#f00",
          green: "#0f0",
          yellow: "#ff0",
          blue: "#00f",
          magenta: "#f0f",
          cyan: "#0ff",
          white: "#fff",
          brightBlack: "#111",
          brightRed: "#f11",
          brightGreen: "#1f1",
          brightYellow: "#ff1",
          brightBlue: "#11f",
          brightMagenta: "#f1f",
          brightCyan: "#1ff",
          brightWhite: "#eee",
        },
      },
      syntax: {
        comment: "#666",
        keyword: "#c678dd",
        string: "#98c379",
        number: "#d19a66",
        literal: "#56b6c2",
        builtin: "#e6c07b",
        name: "#e06c75",
        title: "#61aeee",
        type: "#d19a66",
      },
      warning: "#f00",
      caution: "#ff0",
      match: "#ff0",
    },
    {
      id: "dracula",
      name: "Dracula",
      mode: "dark",
      source: "test",
      license: "MIT",
      chrome: {},
      terminal: {
        foreground: "#f8f8f2",
        background: "#282a36",
        cursor: "#bd93f9",
        selectionBackground: "#44475a",
        ansi: {
          black: "#000",
          red: "#f00",
          green: "#0f0",
          yellow: "#ff0",
          blue: "#00f",
          magenta: "#f0f",
          cyan: "#0ff",
          white: "#fff",
          brightBlack: "#111",
          brightRed: "#f11",
          brightGreen: "#1f1",
          brightYellow: "#ff1",
          brightBlue: "#11f",
          brightMagenta: "#f1f",
          brightCyan: "#1ff",
          brightWhite: "#eee",
        },
      },
      syntax: {
        comment: "#666",
        keyword: "#c678dd",
        string: "#98c379",
        number: "#d19a66",
        literal: "#56b6c2",
        builtin: "#e6c07b",
        name: "#e06c75",
        title: "#61aeee",
        type: "#d19a66",
      },
      warning: "#f00",
      caution: "#ff0",
      match: "#ff0",
    },
    {
      id: "shax-light",
      name: "Shax Light",
      mode: "light",
      source: "test",
      license: "MIT",
      chrome: {},
      terminal: {
        foreground: "#000",
        background: "#fff",
        cursor: "#000",
        selectionBackground: "#ddd",
        ansi: {
          black: "#000",
          red: "#f00",
          green: "#0f0",
          yellow: "#ff0",
          blue: "#00f",
          magenta: "#f0f",
          cyan: "#0ff",
          white: "#fff",
          brightBlack: "#111",
          brightRed: "#f11",
          brightGreen: "#1f1",
          brightYellow: "#ff1",
          brightBlue: "#11f",
          brightMagenta: "#f1f",
          brightCyan: "#1ff",
          brightWhite: "#eee",
        },
      },
      syntax: {
        comment: "#666",
        keyword: "#c678dd",
        string: "#98c379",
        number: "#d19a66",
        literal: "#56b6c2",
        builtin: "#e6c07b",
        name: "#e06c75",
        title: "#61aeee",
        type: "#d19a66",
      },
      warning: "#f00",
      caution: "#ff0",
      match: "#ff0",
    },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
});

// Small helper: render and let all the on-mount probes settle.
async function open(): Promise<void> {
  render(<SettingsModal onClose={() => undefined} />);
  await act(async () => {
    // Flush the Promise.all in the modal's mount effect.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Nav layout ─────────────────────────────────────────────────────────

describe("SettingsModal — left nav (M7.5b)", () => {
  it("renders two nav entries: Appearance and Assistant", async () => {
    await open();
    expect(screen.getByTestId("settings-nav-appearance")).toBeInTheDocument();
    expect(screen.getByTestId("settings-nav-assistant")).toBeInTheDocument();
  });

  it("defaults to Appearance active", async () => {
    await open();
    expect(screen.getByTestId("settings-nav-appearance")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("settings-nav-assistant")).toHaveAttribute("data-active", "false");
    // The Appearance section shows the theme radiogroup.
    expect(screen.getByTestId("settings-theme")).toBeInTheDocument();
    // The Assistant section's Off lane is not in the tree yet.
    expect(screen.queryByTestId("settings-lane-none")).toBeNull();
  });

  it("clicking Assistant swaps the right pane to the Claude + Ollama surface", async () => {
    await open();
    fireEvent.click(screen.getByTestId("settings-nav-assistant"));
    expect(screen.getByTestId("settings-nav-assistant")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("settings-lane-none")).toBeInTheDocument();
    expect(screen.getByTestId("settings-lane-api-key")).toBeInTheDocument();
    expect(screen.getByTestId("settings-lane-subscription")).toBeInTheDocument();
    expect(screen.getByTestId("settings-ollama")).toBeInTheDocument();
    // And Theme picker is unmounted.
    expect(screen.queryByTestId("settings-theme")).toBeNull();
  });

  it("nav footer surfaces the local-first reassurance", async () => {
    await open();
    // The strip lives in the nav column; it's not a form control so we
    // check on visible copy.
    expect(screen.getByText(/local-first · nothing syncs/i)).toBeInTheDocument();
  });
});

// ── Bottom status bar ──────────────────────────────────────────────────

describe("SettingsModal — footer status (M7.5b)", () => {
  it("shows 'all changes saved' when the modal opens cleanly", async () => {
    await open();
    expect(screen.getByTestId("settings-saved-status")).toHaveTextContent(/all changes saved/i);
  });

  it("shows the Esc / ⌘, close hint on the right", async () => {
    await open();
    expect(screen.getByText(/Esc or/i)).toBeInTheDocument();
    expect(screen.getByText(/to close/i)).toBeInTheDocument();
  });
});

// ── Keychain reassurance strip ─────────────────────────────────────────

describe("SettingsModal — keychain reassurance (M7.5b)", () => {
  it("is not shown until the API-key lane is selected", async () => {
    await open();
    fireEvent.click(screen.getByTestId("settings-nav-assistant"));
    expect(screen.queryByTestId("settings-keychain-reassurance")).toBeNull();
  });

  it("appears under the API-key input when that lane is active", async () => {
    mockGetAssistantConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      provider: "claude",
      claude_lane: "api-key",
    });
    await open();
    fireEvent.click(screen.getByTestId("settings-nav-assistant"));
    const strip = screen.getByTestId("settings-keychain-reassurance");
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveTextContent(/os keychain/i);
    expect(strip).toHaveTextContent(/never written to disk/i);
  });
});

// ── Ollama routing ─────────────────────────────────────────────────────

describe("SettingsModal — Ollama surfaces under the Assistant nav (M7.5b)", () => {
  it("the Ollama lane and its detected-models copy live in the Assistant pane", async () => {
    mockProbeOllama.mockResolvedValue(OLLAMA_REACHABLE);
    await open();
    fireEvent.click(screen.getByTestId("settings-nav-assistant"));
    expect(screen.getByTestId("settings-ollama")).toBeInTheDocument();
    // Ollama is under the same Assistant nav, not a separate top-level.
    expect(screen.queryByTestId("settings-nav-ollama")).toBeNull();
  });
});

// ── Appearance (M10.4) ─────────────────────────────────────────────────

// Small helper: the last `preferences` argument
// `savePreferences` was called with. `.at(-1)` isn't in the
// current tsconfig target lib, so index by length.
function lastSaved(): { appearance: AppearancePreferences } {
  const calls = mockSavePreferences.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error("savePreferences was never called");
  return last[0] as { appearance: AppearancePreferences };
}

describe("SettingsModal — Appearance section (M10.4)", () => {
  it("renders every M10.4 control", async () => {
    await open();
    expect(screen.getByTestId("settings-theme")).toBeInTheDocument();
    expect(screen.getByTestId("settings-preset-light")).toBeInTheDocument();
    expect(screen.getByTestId("settings-preset-dark")).toBeInTheDocument();
    expect(screen.getByTestId("settings-font-family")).toBeInTheDocument();
    expect(screen.getByTestId("settings-font-size")).toBeInTheDocument();
    expect(screen.getByTestId("settings-ligatures")).toBeInTheDocument();
  });

  it("populates the light preset dropdown with only light-mode presets", async () => {
    await open();
    const select = screen.getByTestId<HTMLSelectElement>("settings-preset-light");
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("shax-light");
    expect(options).not.toContain("shax-dark");
    expect(options).not.toContain("dracula");
  });

  it("populates the dark preset dropdown with only dark-mode presets", async () => {
    await open();
    const select = screen.getByTestId<HTMLSelectElement>("settings-preset-dark");
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain("shax-dark");
    expect(options).toContain("dracula");
    expect(options).not.toContain("shax-light");
  });

  it("changing the dark preset persists appearance and dispatches shax:preference-changed", async () => {
    const events: CustomEvent<unknown>[] = [];
    const handler = (e: Event): void => {
      events.push(e as CustomEvent<unknown>);
    };
    window.addEventListener("shax:preference-changed", handler);
    try {
      await open();
      const select = screen.getByTestId<HTMLSelectElement>("settings-preset-dark");
      await act(async () => {
        fireEvent.change(select, { target: { value: "dracula" } });
        await Promise.resolve();
      });
      expect(lastSaved().appearance.theme_dark).toBe("dracula");
      const lastEvent = events[events.length - 1];
      if (lastEvent === undefined) throw new Error("no shax:preference-changed event fired");
      const detail = lastEvent.detail as { appearance?: { theme_dark: string } };
      expect(detail.appearance?.theme_dark).toBe("dracula");
    } finally {
      window.removeEventListener("shax:preference-changed", handler);
    }
  });

  it("picking a bundled font persists the family; picking the default sends null", async () => {
    await open();
    const select = screen.getByTestId<HTMLSelectElement>("settings-font-family");
    await act(async () => {
      fireEvent.change(select, { target: { value: "Fira Code" } });
      await Promise.resolve();
    });
    expect(lastSaved().appearance.font_family).toBe("Fira Code");
    await act(async () => {
      fireEvent.change(select, { target: { value: "" } });
      await Promise.resolve();
    });
    expect(lastSaved().appearance.font_family).toBeNull();
  });

  it("dragging the font-size slider persists the numeric value", async () => {
    await open();
    const slider = screen.getByTestId<HTMLInputElement>("settings-font-size");
    await act(async () => {
      fireEvent.change(slider, { target: { value: "18" } });
      await Promise.resolve();
    });
    expect(lastSaved().appearance.font_size).toBe(18);
    expect(screen.getByTestId("settings-font-size-value")).toHaveTextContent("18px");
  });

  it("toggling ligatures off persists false", async () => {
    await open();
    const toggle = screen.getByTestId<HTMLInputElement>("settings-ligatures");
    expect(toggle.checked).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(lastSaved().appearance.ligatures).toBe(false);
  });
});
