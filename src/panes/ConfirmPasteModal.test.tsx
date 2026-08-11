/**
 * ConfirmPasteModal unit tests (jsdom / Vitest).
 *
 * Covers the M12.3 paste-safety modal: preview shows the payload,
 * default "Paste as one command" is on, Enter confirms, Escape
 * cancels, click-outside cancels, the toggle round-trips through to
 * `onConfirm`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ConfirmPasteModal } from "./ConfirmPasteModal";
import { _resetModalLayersForTests } from "../lib/modalLayer";

afterEach(() => {
  cleanup();
  _resetModalLayersForTests();
});

const noop = (): void => {};

describe("ConfirmPasteModal", () => {
  it("shows the payload verbatim in the preview area", () => {
    const payload = "echo one\necho two\necho three\necho four\necho five";
    render(<ConfirmPasteModal payload={payload} onConfirm={noop} onCancel={noop} />);
    // `textContent` preserves the raw string (including LFs), unlike
    // toHaveTextContent which normalises whitespace to single spaces.
    expect(screen.getByTestId("confirm-paste-preview").textContent).toBe(payload);
  });

  it("headline reports the number of lines and bytes", () => {
    const payload = "line1\nline2\nline3";
    const { container } = render(
      <ConfirmPasteModal payload={payload} onConfirm={noop} onCancel={noop} />,
    );
    expect(screen.getByTestId("confirm-paste-modal")).toHaveAttribute("data-lines", "3");
    // 5 + 1 + 5 + 1 + 5 = 17 bytes for line1\nline2\nline3.
    expect(screen.getByTestId("confirm-paste-modal")).toHaveAttribute("data-bytes", "17");
    expect(container.textContent).toContain("Paste 3 lines");
  });

  it("clicking Paste fires onConfirm (no toggle in the simplified modal)", () => {
    const onConfirm = vi.fn();
    render(<ConfirmPasteModal payload="a\nb" onConfirm={onConfirm} onCancel={noop} />);
    // Historical "Paste as one command" toggle removed — the modal is
    // just Cancel / Paste. The shell's bracketed-paste handling
    // already provides the multi-line safety layer.
    expect(screen.queryByTestId("confirm-paste-one-command")).toBeNull();
    fireEvent.click(screen.getByTestId("confirm-paste-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith();
  });

  it("clicking Cancel fires onCancel", () => {
    const onCancel = vi.fn();
    render(<ConfirmPasteModal payload="a\nb" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("confirm-paste-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("Escape fires onCancel", () => {
    const onCancel = vi.fn();
    render(<ConfirmPasteModal payload="a\nb" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("Enter fires onConfirm", () => {
    const onConfirm = vi.fn();
    render(<ConfirmPasteModal payload="a\nb" onConfirm={onConfirm} onCancel={noop} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop cancels (Cancel-outside gesture)", () => {
    const onCancel = vi.fn();
    render(<ConfirmPasteModal payload="a\nb" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("confirm-paste-modal"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("clicks on the panel body do NOT cancel", () => {
    const onCancel = vi.fn();
    render(<ConfirmPasteModal payload="a\nb" onConfirm={noop} onCancel={onCancel} />);
    // Preview lives inside the panel — clicking it shouldn't bubble up
    // to the backdrop's cancel handler.
    fireEvent.click(screen.getByTestId("confirm-paste-preview"));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
