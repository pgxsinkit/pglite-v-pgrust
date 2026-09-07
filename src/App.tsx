import type { JSX } from "react";
import { useState } from "react";

import type { ConfigurationOption } from "./components/ConfigurationSelector";
import { ConfigurationSelector } from "./components/ConfigurationSelector";
import { EnvironmentHeader } from "./components/EnvironmentHeader";
import { SuiteSection } from "./components/SuiteSection";
import type { ConfigurationSelection } from "./configuration-selection";
import {
  describeRejectedBaseline,
  describeUnavailableConfigurationIds,
  describeUnknownConfigurationIds,
  resolveBaselineId,
  writeConfigurationSelection,
} from "./configuration-selection";
import { BASELINE_CANDIDATE_IDS, BASELINE_CONFIGURATION_ID, CONFIGURATION_IDS, CONFIGURATIONS } from "./configurations";
import { configurationAvailability } from "./engines/availability";
import type { EnvironmentInfo } from "./environment";
import { SUITES } from "./suites";

export interface AppProps {
  /**
   * Read once, before the first render, and never again: the environment does not change while the
   * page is open, and one of its capabilities can only be detected asynchronously — so it is
   * awaited in `main.tsx` and handed in, rather than filled in under a rendered header.
   */
  readonly environment: EnvironmentInfo;
  /**
   * The columns this page opened with: the URL's `?configurations=`/`?baseline=`, resolved against
   * what this browser can run. Also read once and handed in, for the same reason — the table's
   * columns are settled before it is drawn, not shortly after.
   */
  readonly selection: ConfigurationSelection;
}

/** What the reader is currently comparing; the URL is rewritten to match it on every change. */
interface ChosenSelection {
  readonly selectedIds: readonly string[];
  readonly baselineId: string | null;
}

/**
 * What the URL asked for and did not get, in the reader's words.
 *
 * Shown until the reader changes something themselves, at which point the note is about a link that
 * no longer describes the page.
 */
function selectionNotes(selection: ConfigurationSelection): readonly string[] {
  const notes: string[] = [];
  if (selection.unknownIds.length > 0) {
    notes.push(describeUnknownConfigurationIds(selection.unknownIds));
  }
  if (selection.unavailableIds.length > 0) {
    notes.push(describeUnavailableConfigurationIds(selection.unavailableIds));
  }
  if (selection.rejectedBaselineId !== null) {
    notes.push(describeRejectedBaseline(selection.rejectedBaselineId, selection.baselineId));
  }
  return notes;
}

export function App({ environment, selection }: AppProps): JSX.Element {
  const [chosen, setChosen] = useState<ChosenSelection>(() => ({
    selectedIds: selection.selectedIds,
    baselineId: selection.baselineId,
  }));
  const [notes, setNotes] = useState<readonly string[]>(() => selectionNotes(selection));

  const options: readonly ConfigurationOption[] = CONFIGURATIONS.map((configuration) => ({
    configuration,
    availability: configurationAvailability(configuration, environment),
  }));

  function choose(selectedIds: readonly string[], baselineId: string | null): void {
    writeConfigurationSelection(selectedIds, baselineId);
    setChosen({ selectedIds, baselineId });
    setNotes([]);
  }

  /** Ticking a box keeps the column order; unticking the Baseline moves it on by the same rule. */
  function toggle(id: string, selected: boolean): void {
    const selectedIds = CONFIGURATION_IDS.filter((candidate) =>
      candidate === id ? selected : chosen.selectedIds.includes(candidate),
    );
    choose(
      selectedIds,
      resolveBaselineId(selectedIds, BASELINE_CANDIDATE_IDS, chosen.baselineId, BASELINE_CONFIGURATION_ID),
    );
  }

  function chooseBaseline(id: string): void {
    choose(
      chosen.selectedIds,
      resolveBaselineId(chosen.selectedIds, BASELINE_CANDIDATE_IDS, id, BASELINE_CONFIGURATION_ID),
    );
  }

  const selectedConfigurations = CONFIGURATIONS.filter((configuration) =>
    chosen.selectedIds.includes(configuration.id),
  );
  const baseline = CONFIGURATIONS.find((configuration) => configuration.id === chosen.baselineId) ?? null;

  return (
    <main>
      <h1>pglite-v-pgrust</h1>
      <p>
        The same SQL workloads run against two WebAssembly Postgres builds, with wa-sqlite alongside them as a
        calibration reference, timed inside each Engine&apos;s worker. Lower is better; times are milliseconds.
      </p>
      <EnvironmentHeader environment={environment} />
      {notes.map((note) => (
        <p key={note} className="non-standard-note">
          {note}
        </p>
      ))}
      <ConfigurationSelector
        options={options}
        selectedIds={chosen.selectedIds}
        baselineId={chosen.baselineId}
        onToggle={toggle}
        onBaseline={chooseBaseline}
      />
      {SUITES.map((suite) => (
        <SuiteSection
          key={suite.id}
          suite={suite}
          environment={environment}
          configurations={selectedConfigurations}
          baseline={baseline}
        />
      ))}
    </main>
  );
}
