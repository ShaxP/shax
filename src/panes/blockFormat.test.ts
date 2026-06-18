import { describe, it, expect } from "vitest";
import { formatDuration } from "./blockFormat";

describe("formatDuration", () => {
  it("renders sub-second durations as ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders sub-minute durations as fixed-2 seconds", () => {
    expect(formatDuration(1000)).toBe("1.00s");
    expect(formatDuration(1840)).toBe("1.84s");
    expect(formatDuration(59_990)).toBe("59.99s");
  });

  it("renders minutes as m:ss", () => {
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(83_500)).toBe("1:23");
    expect(formatDuration(3_599_000)).toBe("59:59");
  });

  it("renders hours as h:mm:ss", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("renders null and invalid inputs as --", () => {
    expect(formatDuration(null)).toBe("--");
    expect(formatDuration(undefined)).toBe("--");
    expect(formatDuration(Number.NaN)).toBe("--");
    expect(formatDuration(-1)).toBe("--");
  });
});
