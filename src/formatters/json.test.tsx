/**
 * Render tests for the JSON formatter (M4 slice 4.6a).
 * The pure detection / parser logic lives in `detectJson.test.ts`;
 * here we exercise the React surface: matcher precedence, the
 * collapsed-by-default behaviour, and the disclosure toggle.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import { jsonFormatter } from "./json";
import { findFormatter, register, resetRegistryForTests } from "./registry";
import { catFormatter } from "./cat";
import type { FormatterContext } from "./types";

const ctx = (overrides: Partial<FormatterContext> = {}): FormatterContext => ({
  argv: [],
  cwd: "/tmp",
  env: {},
  exitCode: 0,
  durationMs: 5,
  stdout: "",
  stderr: "",
  rawAnsi: "",
  paneId: "pty-1",
  ...overrides,
});

describe("jsonFormatter matcher", () => {
  it("matches when stdout parses as JSON", () => {
    const c = ctx({ argv: ["cat", "foo.json"], stdout: '{"a":1}' });
    expect(jsonFormatter.matcher.kind).toBe("predicate");
    if (jsonFormatter.matcher.kind !== "predicate") return; // type guard
    expect(jsonFormatter.matcher.test(c)).toBe(true);
  });

  it("matches when argv0 is jq, even before checking stdout", () => {
    const c = ctx({ argv: ["jq", "."], stdout: "" });
    if (jsonFormatter.matcher.kind !== "predicate") return;
    expect(jsonFormatter.matcher.test(c)).toBe(true);
  });

  it("declines plain text output", () => {
    const c = ctx({ argv: ["cat", "README.md"], stdout: "# hello" });
    if (jsonFormatter.matcher.kind !== "predicate") return;
    expect(jsonFormatter.matcher.test(c)).toBe(false);
  });
});

describe("registry precedence", () => {
  it("JSON beats cat for `cat foo.json`", () => {
    resetRegistryForTests();
    register(catFormatter);
    register(jsonFormatter);
    const c = ctx({ argv: ["cat", "foo.json"], stdout: '{"a":1}' });
    expect(findFormatter(c)?.name).toBe("json");
    resetRegistryForTests();
  });

  it("cat still wins for `cat README.md`", () => {
    resetRegistryForTests();
    register(catFormatter);
    register(jsonFormatter);
    const c = ctx({ argv: ["cat", "README.md"], stdout: "# hello" });
    expect(findFormatter(c)?.name).toBe("cat");
    resetRegistryForTests();
  });
});

describe("JsonView rendering", () => {
  it("renders the root object expanded by default", () => {
    const c = ctx({ argv: ["jq", "."], stdout: '{"name":"Ada","age":36}' });
    render(<>{jsonFormatter.render(c)}</>);
    expect(screen.getByTestId("formatter-json")).toBeInTheDocument();
    // Both keys are visible because the root is expanded.
    expect(screen.getByText('"name"')).toBeInTheDocument();
    expect(screen.getByText('"age"')).toBeInTheDocument();
  });

  it("nested objects start collapsed", () => {
    const c = ctx({ argv: ["jq", "."], stdout: '{"outer":{"inner":1}}' });
    render(<>{jsonFormatter.render(c)}</>);
    // Outer key is visible, but the inner content is collapsed.
    expect(screen.getByText('"outer"')).toBeInTheDocument();
    expect(screen.queryByText('"inner"')).toBeNull();
  });

  it("expands a nested container on disclosure click", () => {
    const c = ctx({ argv: ["jq", "."], stdout: '{"outer":{"inner":1}}' });
    render(<>{jsonFormatter.render(c)}</>);
    // Click the disclosure on the inner container.
    const triangle = screen.getByLabelText("Expand");
    fireEvent.click(triangle);
    // Inner key is now visible.
    expect(screen.getByText('"inner"')).toBeInTheDocument();
  });

  it("renders arrays with bracket indices", () => {
    const c = ctx({ argv: ["jq", "."], stdout: '["a","b","c"]' });
    render(<>{jsonFormatter.render(c)}</>);
    expect(screen.getByText("[0]")).toBeInTheDocument();
    expect(screen.getByText("[1]")).toBeInTheDocument();
    expect(screen.getByText("[2]")).toBeInTheDocument();
  });

  it("shows collapsed-summary count", () => {
    const c = ctx({ argv: ["jq", "."], stdout: '{"a":{"x":1,"y":2,"z":3}}' });
    render(<>{jsonFormatter.render(c)}</>);
    // The nested object is collapsed and shows "3 entries".
    expect(screen.getByText("3 entries")).toBeInTheDocument();
  });

  it("renders the null literal distinctly", () => {
    const c = ctx({ argv: ["jq", "."], stdout: '{"x":null}' });
    render(<>{jsonFormatter.render(c)}</>);
    expect(screen.getByText("null")).toBeInTheDocument();
  });
});
