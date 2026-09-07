/**
 * Which Configurations a Run compares, and which of them every ratio is taken against.
 *
 * The page has always run all fourteen and taken every ratio against `PGlite Memory`. Both are now
 * choices: a checkbox per Configuration and a Baseline radio beside it, defaulting to exactly what
 * the page did before — everything this browser can run, with `PGlite Memory` as the Baseline.
 *
 * The choice is carried on the URL, in the same out-of-band shape as `?rttIterations=N` and
 * `?concurrencyClients=N`: `?configurations=<id,id,…>` and `?baseline=<id>`. That is what makes a
 * narrowed Run reproducible — the link is the run — and it is what `bun run bench
 * --configurations`/`--baseline` hand to the page rather than inventing a second mechanism. An
 * absent `configurations` means every available Configuration, and an id that names nothing is
 * ignored with a visible note rather than thrown: a mistyped URL must leave the page running
 * something, not blank it.
 *
 * Everything here except the two `read`/`write` wrappers is pure, so the resolution rules — which
 * columns, in which order, and which of them is the Baseline — are decided in one tested function
 * that the page, the URL and the CLI all share.
 */

import { BASELINE_CANDIDATE_IDS, BASELINE_CONFIGURATION_ID, CONFIGURATION_IDS, CONFIGURATIONS } from "./configurations";
import type { AvailabilityEnvironment } from "./engines/availability";
import { configurationAvailability } from "./engines/availability";

/** The query parameter that narrows the Run to some of the Configurations. */
export const CONFIGURATIONS_PARAM = "configurations";

/** The query parameter that chooses the Configuration every ratio is taken against. */
export const BASELINE_PARAM = "baseline";

/** How a list of ids is carried in one parameter value. */
const ID_SEPARATOR = ",";

/**
 * The ids a `location.search` asks for, or null when the parameter is absent.
 *
 * An empty value is null too, not an empty selection: `?configurations=` is a URL somebody trimmed,
 * and answering it with a table of no columns would be answering a typo with a blank page.
 */
export function parseConfigurationIds(search: string): readonly string[] | null {
  const raw = new URLSearchParams(search).get(CONFIGURATIONS_PARAM);
  if (raw === null) {
    return null;
  }
  const ids = raw
    .split(ID_SEPARATOR)
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return ids.length === 0 ? null : ids;
}

/** The Baseline a `location.search` asks for, or null when there is none. */
export function parseBaselineId(search: string): string | null {
  const raw = new URLSearchParams(search).get(BASELINE_PARAM);
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The value side of the `configurations` parameter. */
export function formatConfigurationIds(ids: readonly string[]): string {
  return ids.join(ID_SEPARATOR);
}

/**
 * Write both parameters onto a `URLSearchParams`, removing whichever was not asked for.
 *
 * Every other parameter on the URL is left exactly as it was: a shortened RTT Run that also narrows
 * its columns is one link, not two.
 */
export function setSelectionParams(
  params: URLSearchParams,
  selectedIds: readonly string[] | null,
  baselineId: string | null,
): void {
  if (selectedIds === null) {
    params.delete(CONFIGURATIONS_PARAM);
  } else {
    params.set(CONFIGURATIONS_PARAM, formatConfigurationIds(selectedIds));
  }
  if (baselineId === null) {
    params.delete(BASELINE_PARAM);
  } else {
    params.set(BASELINE_PARAM, baselineId);
  }
}

/**
 * A query string, with the separator left readable.
 *
 * `URLSearchParams` percent-encodes a comma; a comma is a legal query character and this link is
 * meant to be pasted into a message and read, so it is put back. Nothing else is decoded.
 */
export function formatSearch(params: URLSearchParams): string {
  const query = params.toString().replaceAll("%2C", ID_SEPARATOR);
  return query === "" ? "" : `?${query}`;
}

/** The search string that reproduces this selection, on top of whatever else the URL carries. */
export function formatSelectionSearch(
  search: string,
  selectedIds: readonly string[] | null,
  baselineId: string | null,
): string {
  const params = new URLSearchParams(search);
  setSelectionParams(params, selectedIds, baselineId);
  return formatSearch(params);
}

/** Everything the resolution rules need, so they can be applied without a browser. */
export interface ConfigurationSelectionRequest {
  /** Every Configuration id, in column order. */
  readonly allIds: readonly string[];
  /** The ids that can run here; the rest can never be selected. */
  readonly availableIds: readonly string[];
  /** The ids allowed to be the Baseline (the Reference Engine is not one of them). */
  readonly baselineCandidateIds: readonly string[];
  /** The `configurations` parameter, or null for every available Configuration. */
  readonly requestedIds: readonly string[] | null;
  /** The `baseline` parameter, or null when none was asked for. */
  readonly requestedBaselineId: string | null;
  /** The Baseline used whenever it is selectable and nothing else was asked for. */
  readonly defaultBaselineId: string;
}

/** What the page runs, plus everything the URL asked for and did not get. */
export interface ConfigurationSelection {
  /** The Configurations to run, in column order — never the order the URL listed them in. */
  readonly selectedIds: readonly string[];
  /** The column every ratio is taken against; null only when nothing at all is selected. */
  readonly baselineId: string | null;
  /** URL ids that name no Configuration. */
  readonly unknownIds: readonly string[];
  /** URL ids that name a Configuration this browser cannot run. */
  readonly unavailableIds: readonly string[];
  /** The Baseline the URL asked for and did not get; null when it got what it asked for. */
  readonly rejectedBaselineId: string | null;
}

/**
 * The Baseline of a selection.
 *
 * In order: the one asked for, if it is selected and may be a Baseline; otherwise the default, on
 * the same condition; otherwise the first selected column that may be a Baseline. The last resort
 * is the first selected column whatever it is — a table of nothing but Reference Engine columns
 * still has to take its ratios against one of them.
 */
export function resolveBaselineId(
  selectedIds: readonly string[],
  baselineCandidateIds: readonly string[],
  requestedBaselineId: string | null,
  defaultBaselineId: string,
): string | null {
  const candidates = selectedIds.filter((id) => baselineCandidateIds.includes(id));
  if (requestedBaselineId !== null && candidates.includes(requestedBaselineId)) {
    return requestedBaselineId;
  }
  if (candidates.includes(defaultBaselineId)) {
    return defaultBaselineId;
  }
  return candidates[0] ?? selectedIds[0] ?? null;
}

/**
 * The selection a request resolves to, and what was ignored getting there.
 *
 * A `configurations` list that survives nothing — every id mistyped, or every id naming a
 * Configuration this browser cannot run — falls back to every available Configuration rather than
 * to an empty table, and says so through `unknownIds`/`unavailableIds`.
 */
export function resolveConfigurationSelection(request: ConfigurationSelectionRequest): ConfigurationSelection {
  const known = new Set(request.allIds);
  const available = new Set(request.availableIds);
  const requestedIds = request.requestedIds;
  const unknownIds = requestedIds === null ? [] : requestedIds.filter((id) => !known.has(id));
  const unavailableIds = requestedIds === null ? [] : requestedIds.filter((id) => known.has(id) && !available.has(id));
  const wanted =
    requestedIds === null ? null : new Set(requestedIds.filter((id) => known.has(id) && available.has(id)));
  const selectedIds =
    wanted === null || wanted.size === 0
      ? request.allIds.filter((id) => available.has(id))
      : request.allIds.filter((id) => wanted.has(id));
  const baselineId = resolveBaselineId(
    selectedIds,
    request.baselineCandidateIds,
    request.requestedBaselineId,
    request.defaultBaselineId,
  );
  return {
    selectedIds,
    baselineId,
    unknownIds,
    unavailableIds,
    rejectedBaselineId:
      request.requestedBaselineId !== null && request.requestedBaselineId !== baselineId
        ? request.requestedBaselineId
        : null,
  };
}

/** Whether the URL asked for something it did not get, and should therefore be rewritten. */
export function selectionNeedsCorrection(selection: ConfigurationSelection): boolean {
  return (
    selection.unknownIds.length > 0 || selection.unavailableIds.length > 0 || selection.rejectedBaselineId !== null
  );
}

/** The Configuration ids this browser can run, in column order. */
export function availableConfigurationIds(environment: AvailabilityEnvironment): readonly string[] {
  return CONFIGURATIONS.filter((configuration) => configurationAvailability(configuration, environment).available).map(
    (configuration) => configuration.id,
  );
}

/**
 * The selection the current URL asks for, resolved against this browser.
 *
 * Read once, before the first render, like the environment it needs: which columns exist is settled
 * before the table is drawn rather than shortly after.
 */
export function readConfigurationSelection(environment: AvailabilityEnvironment): ConfigurationSelection {
  const search = typeof location === "undefined" ? "" : location.search;
  return resolveConfigurationSelection({
    allIds: CONFIGURATION_IDS,
    availableIds: availableConfigurationIds(environment),
    baselineCandidateIds: BASELINE_CANDIDATE_IDS,
    requestedIds: parseConfigurationIds(search),
    requestedBaselineId: parseBaselineId(search),
    defaultBaselineId: BASELINE_CONFIGURATION_ID,
  });
}

/**
 * Put a selection on the URL, so the Run that is about to happen is reproducible by link.
 *
 * `replaceState`, never `pushState`: ticking four boxes is one decision, not four pages of history.
 */
export function writeConfigurationSelection(selectedIds: readonly string[], baselineId: string | null): void {
  if (typeof location === "undefined" || typeof history === "undefined") {
    return;
  }
  const search = formatSelectionSearch(location.search, selectedIds, baselineId);
  history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
}

/** How ids that name no Configuration are reported on the page. */
export function describeUnknownConfigurationIds(ids: readonly string[]): string {
  return `The URL asked for Configurations that do not exist; ignored: ${ids.join(", ")}`;
}

/** How ids this browser cannot run are reported when the URL asked for them by name. */
export function describeUnavailableConfigurationIds(ids: readonly string[]): string {
  return `The URL asked for Configurations this browser cannot run; not selected: ${ids.join(", ")}`;
}

/** How a Baseline the selection cannot honour is reported, together with the one used instead. */
export function describeRejectedBaseline(requestedId: string, baselineId: string | null): string {
  return (
    `The URL asked for the Baseline ${requestedId}, which is not a selected Configuration a ratio ` +
    `may be taken against; using ${baselineId ?? "none"} instead`
  );
}

/**
 * What every Markdown export says about the columns in it.
 *
 * Ids rather than labels: a label carries commas of its own, and an id is what the URL and
 * `bun run bench --configurations` take — so this line is the run's own reproduction instructions.
 */
export function describeConfigurationSelection(
  selectedIds: readonly string[],
  baselineId: string | null,
  totalCount: number,
): string {
  return `Configurations (${selectedIds.length} of ${totalCount}): ${
    selectedIds.length === 0 ? "none" : selectedIds.join(", ")
  } | Baseline: ${baselineId ?? "none"}`;
}
