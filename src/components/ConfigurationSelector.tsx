import type { JSX } from "react";

import { canBeBaseline, REFERENCE_ENGINE_BASELINE_REASON } from "../configurations";
import type { Availability } from "../engines/availability";
import type { Configuration } from "../engines/contract";

/** One Configuration and whether this browser can run it at all. */
export interface ConfigurationOption {
  readonly configuration: Configuration;
  readonly availability: Availability;
}

export interface ConfigurationSelectorProps {
  /** Every Configuration, in column order; the unavailable ones are listed too, with their reason. */
  readonly options: readonly ConfigurationOption[];
  readonly selectedIds: readonly string[];
  readonly baselineId: string | null;
  readonly onToggle: (id: string, selected: boolean) => void;
  readonly onBaseline: (id: string) => void;
}

/**
 * The columns a Run compares, and the one every ratio is taken against.
 *
 * Every Configuration is listed, including the ones this browser cannot run: their checkbox is
 * disabled and unticked, and their own reason is shown beside it — which is where a reader now
 * learns what happened to a column that used to appear in the table saying `skipped`.
 *
 * The Baseline radio is offered for a ticked Configuration that may be one. The Reference Engine's
 * is greyed out on purpose: wa-sqlite is here to calibrate the harness, not to be the thing every
 * other column is measured against.
 */
export function ConfigurationSelector(props: ConfigurationSelectorProps): JSX.Element {
  return (
    <section className="configurations" data-testid="configuration-selector">
      <h2>Configurations</h2>
      <p className="description">
        Only the ticked Configurations are run, and they appear as columns in the fixed order below. The Baseline is the
        column every ratio is taken against. Both are carried on the URL, so a Run is reproducible by link.
      </p>
      <ul className="configuration-list">
        {props.options.map((option) => (
          <ConfigurationRow
            key={option.configuration.id}
            option={option}
            selected={props.selectedIds.includes(option.configuration.id)}
            isBaseline={props.baselineId === option.configuration.id}
            onToggle={props.onToggle}
            onBaseline={props.onBaseline}
          />
        ))}
      </ul>
      {props.selectedIds.length === 0 ? (
        <p className="non-standard-note">No Configurations are selected, so a Run would have nothing to measure.</p>
      ) : null}
    </section>
  );
}

interface ConfigurationRowProps {
  readonly option: ConfigurationOption;
  readonly selected: boolean;
  readonly isBaseline: boolean;
  readonly onToggle: (id: string, selected: boolean) => void;
  readonly onBaseline: (id: string) => void;
}

function ConfigurationRow(props: ConfigurationRowProps): JSX.Element {
  const { configuration, availability } = props.option;
  const baselineAllowed = canBeBaseline(configuration);
  return (
    <li className={availability.available ? undefined : "unavailable"}>
      <label>
        <input
          type="checkbox"
          data-testid={`configuration-${configuration.id}`}
          checked={props.selected}
          disabled={!availability.available}
          onChange={(event) => {
            props.onToggle(configuration.id, event.target.checked);
          }}
        />
        {configuration.label}
      </label>
      <label className="baseline-choice" title={baselineAllowed ? undefined : REFERENCE_ENGINE_BASELINE_REASON}>
        <input
          type="radio"
          name="baseline"
          data-testid={`baseline-${configuration.id}`}
          checked={props.isBaseline}
          disabled={!props.selected || !baselineAllowed}
          onChange={() => {
            props.onBaseline(configuration.id);
          }}
        />
        Baseline
      </label>
      <code className="configuration-id">{configuration.id}</code>
      {/* Always rendered, empty when there is nothing to say: every row contributes the same four
          cells to the grid, so the columns stay columns. */}
      <span className="reason">{availability.available ? "" : (availability.reason ?? "unavailable")}</span>
    </li>
  );
}
