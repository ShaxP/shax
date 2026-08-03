import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ConfirmCloseModal, type ConfirmCloseVerb } from "./ConfirmCloseModal";

afterEach(() => {
  cleanup();
});

/** Small helper for rendering the modal with sensible defaults. */
function mount(
  props: Partial<{
    count: number;
    verb: ConfirmCloseVerb;
    onConfirm: () => void;
    onCancel: () => void;
  }> = {},
) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(
    <ConfirmCloseModal
      count={props.count ?? 1}
      verb={props.verb ?? "pane"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmCloseModal — wording", () => {
  it("singular pane close", () => {
    mount({ count: 1, verb: "pane" });
    expect(screen.getByTestId("confirm-close-modal")).toHaveTextContent(
      "1 command is still running. Close pane anyway?",
    );
    expect(screen.getByTestId("confirm-close-confirm")).toHaveTextContent("Close anyway");
  });

  it("plural tab close", () => {
    mount({ count: 3, verb: "tab" });
    expect(screen.getByTestId("confirm-close-modal")).toHaveTextContent(
      "3 commands are still running. Close tab anyway?",
    );
  });

  it("window close", () => {
    mount({ count: 2, verb: "window" });
    expect(screen.getByTestId("confirm-close-modal")).toHaveTextContent(
      "2 commands are still running. Close window anyway?",
    );
  });

  it("app quit uses 'Quit anyway' button label", () => {
    mount({ count: 4, verb: "app" });
    expect(screen.getByTestId("confirm-close-modal")).toHaveTextContent(
      "4 commands are still running. Quit anyway?",
    );
    expect(screen.getByTestId("confirm-close-confirm")).toHaveTextContent("Quit anyway");
  });
});

describe("ConfirmCloseModal — actions", () => {
  it("clicking Confirm fires onConfirm", () => {
    const { onConfirm } = mount();
    fireEvent.click(screen.getByTestId("confirm-close-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clicking Cancel fires onCancel", () => {
    const { onCancel } = mount();
    fireEvent.click(screen.getByTestId("confirm-close-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop fires onCancel (soft dismiss)", () => {
    const { onCancel } = mount();
    fireEvent.click(screen.getByTestId("confirm-close-modal"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicks on the panel body don't bubble to the backdrop cancel", () => {
    const onCancel = vi.fn();
    mount({ onCancel });
    // The confirm button lives inside the panel — clicking it
    // should fire confirm without also firing cancel.
    fireEvent.click(screen.getByTestId("confirm-close-confirm"));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("ConfirmCloseModal — keyboard", () => {
  it("Enter fires onConfirm", () => {
    const { onConfirm } = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Escape fires onCancel", () => {
    const { onCancel } = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("other keys are ignored", () => {
    const { onConfirm, onCancel } = mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
