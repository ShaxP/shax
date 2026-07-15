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

vi.mock("../theme/preferences", () => ({
  loadPreferences: (): Promise<unknown> => mockLoadPreferences() as Promise<unknown>,
  savePreferences: (p: unknown): Promise<unknown> => mockSavePreferences(p) as Promise<unknown>,
}));

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
  mockLoadPreferences.mockResolvedValue({ theme: "system" });
  mockSavePreferences.mockResolvedValue(undefined);
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
