import { describe, expect, test } from "bun:test";

import {
  BASELINE_PARAM,
  CONFIGURATIONS_PARAM,
  describeConfigurationSelection,
  formatSelectionSearch,
  parseBaselineId,
  parseConfigurationIds,
  resolveBaselineId,
  resolveConfigurationSelection,
  selectionNeedsCorrection,
} from "./configuration-selection";
import { BASELINE_CANDIDATE_IDS, BASELINE_CONFIGURATION_ID, CONFIGURATION_IDS } from "./configurations";

/** A request with every Configuration available and nothing asked for: the page's own default. */
function request(overrides: Partial<Parameters<typeof resolveConfigurationSelection>[0]> = {}) {
  return {
    allIds: CONFIGURATION_IDS,
    availableIds: CONFIGURATION_IDS,
    baselineCandidateIds: BASELINE_CANDIDATE_IDS,
    requestedIds: null,
    requestedBaselineId: null,
    defaultBaselineId: BASELINE_CONFIGURATION_ID,
    ...overrides,
  };
}

describe("parseConfigurationIds", () => {
  test("reads a comma-separated list, trimming what a hand-edited URL leaves behind", () => {
    expect(parseConfigurationIds(`?${CONFIGURATIONS_PARAM}=pglite-memory, pgrust-memory ,`)).toEqual([
      "pglite-memory",
      "pgrust-memory",
    ]);
  });

  // A mistyped URL must leave the page running every column, not blank the table.
  test("treats an absent or empty parameter as no request at all", () => {
    expect(parseConfigurationIds("")).toBeNull();
    expect(parseConfigurationIds("?other=1")).toBeNull();
    expect(parseConfigurationIds(`?${CONFIGURATIONS_PARAM}=`)).toBeNull();
    expect(parseConfigurationIds(`?${CONFIGURATIONS_PARAM}= , ,`)).toBeNull();
  });
});

describe("parseBaselineId", () => {
  test("reads the id, and reads nothing out of an empty value", () => {
    expect(parseBaselineId(`?${BASELINE_PARAM}=pgrust-memory`)).toBe("pgrust-memory");
    expect(parseBaselineId(`?${BASELINE_PARAM}=`)).toBeNull();
    expect(parseBaselineId("")).toBeNull();
  });
});

describe("formatSelectionSearch", () => {
  test("writes both parameters, keeps the others, and leaves the separator readable", () => {
    expect(formatSelectionSearch("?rttIterations=3", ["pglite-memory", "pgrust-memory"], "pgrust-memory")).toBe(
      `?rttIterations=3&${CONFIGURATIONS_PARAM}=pglite-memory,pgrust-memory&${BASELINE_PARAM}=pgrust-memory`,
    );
  });

  test("round-trips through the parsers", () => {
    const search = formatSelectionSearch("", ["pglite-memory", "wasqlite-memory"], "pglite-memory");
    expect(parseConfigurationIds(search)).toEqual(["pglite-memory", "wasqlite-memory"]);
    expect(parseBaselineId(search)).toBe("pglite-memory");
  });

  test("removes whichever parameter was not asked for", () => {
    expect(
      formatSelectionSearch(`?${CONFIGURATIONS_PARAM}=pglite-memory&${BASELINE_PARAM}=pglite-memory`, null, null),
    ).toBe("");
  });
});

describe("resolveConfigurationSelection", () => {
  test("runs every available Configuration, in column order, when the URL asks for nothing", () => {
    const resolved = resolveConfigurationSelection(request());
    expect(resolved.selectedIds).toEqual([...CONFIGURATION_IDS]);
    expect(resolved.baselineId).toBe(BASELINE_CONFIGURATION_ID);
    expect(selectionNeedsCorrection(resolved)).toBe(false);
  });

  test("keeps the column order, whatever order the URL listed the ids in", () => {
    const resolved = resolveConfigurationSelection(
      request({ requestedIds: ["pgrust-memory", "pglite-memory", "pglite-memory"] }),
    );
    expect(resolved.selectedIds).toEqual(["pglite-memory", "pgrust-memory"]);
  });

  test("ignores an id that names nothing, and says which one", () => {
    const resolved = resolveConfigurationSelection(request({ requestedIds: ["pglite-memory", "pglite-memry"] }));
    expect(resolved.selectedIds).toEqual(["pglite-memory"]);
    expect(resolved.unknownIds).toEqual(["pglite-memry"]);
    expect(selectionNeedsCorrection(resolved)).toBe(true);
  });

  test("drops an id this browser cannot run, and says which one", () => {
    const resolved = resolveConfigurationSelection(
      request({
        availableIds: CONFIGURATION_IDS.filter((id) => id !== "pgrust-memory"),
        requestedIds: ["pglite-memory", "pgrust-memory"],
      }),
    );
    expect(resolved.selectedIds).toEqual(["pglite-memory"]);
    expect(resolved.unavailableIds).toEqual(["pgrust-memory"]);
  });

  // Answering a URL that survives nothing with an empty table would be answering a typo with a
  // blank page.
  test("falls back to every available Configuration when the request survives nothing", () => {
    const resolved = resolveConfigurationSelection(request({ requestedIds: ["nope", "also-nope"] }));
    expect(resolved.selectedIds).toEqual([...CONFIGURATION_IDS]);
    expect(resolved.unknownIds).toEqual(["nope", "also-nope"]);
  });

  test("takes the Baseline the URL asks for when it is one of the selected columns", () => {
    const resolved = resolveConfigurationSelection(
      request({ requestedIds: ["pglite-memory", "pgrust-memory"], requestedBaselineId: "pgrust-memory" }),
    );
    expect(resolved.baselineId).toBe("pgrust-memory");
    expect(resolved.rejectedBaselineId).toBeNull();
  });

  test("falls back, and reports the rejection, when the Baseline is not selected", () => {
    const resolved = resolveConfigurationSelection(
      request({ requestedIds: ["pglite-memory", "pgrust-memory"], requestedBaselineId: "wasqlite-memory" }),
    );
    expect(resolved.baselineId).toBe(BASELINE_CONFIGURATION_ID);
    expect(resolved.rejectedBaselineId).toBe("wasqlite-memory");
    expect(selectionNeedsCorrection(resolved)).toBe(true);
  });
});

describe("resolveBaselineId", () => {
  test("prefers the default, then the first selected column that may be one", () => {
    expect(resolveBaselineId(CONFIGURATION_IDS, BASELINE_CANDIDATE_IDS, null, BASELINE_CONFIGURATION_ID)).toBe(
      BASELINE_CONFIGURATION_ID,
    );
    expect(
      resolveBaselineId(["pgrust-memory", "wasqlite-memory"], BASELINE_CANDIDATE_IDS, null, BASELINE_CONFIGURATION_ID),
    ).toBe("pgrust-memory");
  });

  // The Reference Engine is never the Baseline of a ratio — unless it is the only thing on the
  // page, because a table still has to take its ratios against one of its own columns.
  test("never offers the Reference Engine unless nothing else is selected", () => {
    expect(
      resolveBaselineId(
        ["pglite-memory", "wasqlite-memory"],
        BASELINE_CANDIDATE_IDS,
        "wasqlite-memory",
        BASELINE_CONFIGURATION_ID,
      ),
    ).toBe("pglite-memory");
    expect(
      resolveBaselineId(
        ["wasqlite-memory", "wasqlite-memory-journal-off"],
        BASELINE_CANDIDATE_IDS,
        null,
        BASELINE_CONFIGURATION_ID,
      ),
    ).toBe("wasqlite-memory");
    expect(resolveBaselineId([], BASELINE_CANDIDATE_IDS, null, BASELINE_CONFIGURATION_ID)).toBeNull();
  });
});

describe("describeConfigurationSelection", () => {
  test("names the columns and the Baseline by id, so the export says how to reproduce it", () => {
    expect(describeConfigurationSelection(["pglite-memory", "pgrust-memory"], "pgrust-memory", 14)).toBe(
      "Configurations (2 of 14): pglite-memory, pgrust-memory | Baseline: pgrust-memory",
    );
  });
});
