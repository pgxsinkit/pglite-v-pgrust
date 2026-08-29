import { describe, expect, test } from "bun:test";

import { EMPTY_CELL, formatMs, formatRatio } from "./format";

describe("formatMs", () => {
  test("renders three decimals", () => {
    expect(formatMs(1.5)).toBe("1.500");
    expect(formatMs(0.0004)).toBe("0.000");
    expect(formatMs(1234.56789)).toBe("1234.568");
  });

  test("renders the placeholder for a missing or non-finite value", () => {
    expect(formatMs(undefined)).toBe(EMPTY_CELL);
    expect(formatMs(Number.NaN)).toBe(EMPTY_CELL);
    expect(formatMs(Number.POSITIVE_INFINITY)).toBe(EMPTY_CELL);
  });
});

describe("formatRatio", () => {
  test("renders value over baseline with two decimals and a multiplication sign", () => {
    expect(formatRatio(0.62, 1)).toBe("0.62×");
    expect(formatRatio(3.1, 2)).toBe("1.55×");
    expect(formatRatio(2, 2)).toBe("1.00×");
  });

  test("renders the placeholder when either side is missing", () => {
    expect(formatRatio(undefined, 1)).toBe(EMPTY_CELL);
    expect(formatRatio(1, undefined)).toBe(EMPTY_CELL);
  });

  test("renders the placeholder rather than dividing by zero", () => {
    expect(formatRatio(1, 0)).toBe(EMPTY_CELL);
  });
});
