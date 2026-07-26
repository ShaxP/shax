import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SchemaPanel } from "./SchemaPanel";

describe("SchemaPanel — kind rendering", () => {
  it("renders a text-input and tracks value", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{ kind: "text-input", label: "Name", resultKey: "name" }}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId("palette-community-name");
    expect(input).toHaveAttribute("data-kind", "text-input");
    fireEvent.change(input, { target: { value: "alice" } });
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "alice" });
  });

  it("renders a dropdown and defaults to first option", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{
          kind: "dropdown",
          label: "Env",
          options: ["dev", "prod"],
          resultKey: "env",
        }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ env: "dev" });
  });

  it("renders a toggle and applies default true", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{ kind: "toggle", label: "Verbose", resultKey: "v", default: true }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ v: true });
  });

  it("multi-select adds and removes values", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{
          kind: "multi-select",
          label: "Tags",
          options: ["a", "b", "c"],
          resultKey: "tags",
        }}
        onSubmit={onSubmit}
      />,
    );
    const container = screen.getByTestId("palette-community-tags");
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    if (checkboxes[0] !== undefined) fireEvent.click(checkboxes[0]);
    if (checkboxes[2] !== undefined) fireEvent.click(checkboxes[2]);
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ tags: ["a", "c"] });
  });

  it("list-picker selects a value on click", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{
          kind: "list-picker",
          label: "Region",
          items: [
            { label: "US East", value: "us-east-1" },
            { label: "EU West", value: "eu-west-1" },
          ],
          resultKey: "region",
        }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByText("EU West"));
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ region: "eu-west-1" });
  });

  it("group renders nested children in a fieldset", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{
          kind: "group",
          legend: "Details",
          items: [
            { kind: "text-input", label: "Name", resultKey: "name" },
            { kind: "toggle", label: "Force", resultKey: "force" },
          ],
        }}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText("Details")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("palette-community-name"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("palette-community-force"));
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).toHaveBeenCalledWith({ name: "x", force: true });
  });
});

describe("SchemaPanel — validation", () => {
  it("required text-input blocks submit and shows the 'required' note", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{ kind: "text-input", label: "Name", resultKey: "name", required: true }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByTestId("palette-community-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("required")).toBeInTheDocument();
  });

  it("Enter on a text-input submits when valid", () => {
    const onSubmit = vi.fn();
    render(
      <SchemaPanel
        node={{ kind: "text-input", label: "Name", resultKey: "name" }}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId("palette-community-name");
    fireEvent.change(input, { target: { value: "alice" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ name: "alice" });
  });
});
