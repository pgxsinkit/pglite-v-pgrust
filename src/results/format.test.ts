import { describe, expect, test } from "bun:test";

import { EMPTY_CELL, formatDetail, formatDetailValue, formatMs, formatRatio } from "./format";

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

describe("formatDetailValue", () => {
  test("keeps a count a count and a measured time three decimals", () => {
    expect(formatDetailValue(812)).toBe("812");
    expect(formatDetailValue(0)).toBe("0");
    expect(formatDetailValue(2.2401)).toBe("2.240");
  });

  test("passes a per-Client spread through: it is already formatted", () => {
    expect(formatDetailValue("1.15 / 2.15 / 3.41")).toBe("1.15 / 2.15 / 3.41");
  });

  // A percentile of an empty sample set is NaN, and the table's own empty cell is what that means.
  test("renders a number that is not one as the empty cell", () => {
    expect(formatDetailValue(Number.NaN)).toBe(EMPTY_CELL);
    expect(formatDetailValue(Number.POSITIVE_INFINITY)).toBe(EMPTY_CELL);
  });
});

describe("formatDetail", () => {
  test("renders the whole Detail on one line, in the order the Suite put it in", () => {
    expect(formatDetail({ "writer total ms": 663.3551, "reader max ms": 664.33, "reader statements": 3 })).toBe(
      "writer total ms = 663.355; reader max ms = 664.330; reader statements = 3",
    );
  });

  test("renders an empty Detail as nothing at all", () => {
    expect(formatDetail({})).toBe("");
  });
});
