import type { JSX } from "react";
import { useState } from "react";

import { BASELINE_CONFIGURATION_ID, BASELINE_CONFIGURATION_LABEL, CONFIGURATIONS } from "../configurations";
import { configurationAvailability } from "../engines/availability";
import type { Configuration } from "../engines/contract";
import type { EnvironmentInfo } from "../environment";
import { formatEnvironmentLine } from "../environment";
import type { GridCells, GridColumn, ResultsGrid } from "../results/grid";
import { cellKey } from "../results/grid";
import { toMarkdown } from "../results/markdown";
import { runSuite } from "../runner/run-suite";
import type { Suite } from "../suites/types";
import { ResultsTable } from "./ResultsTable";

export interface SuiteSectionProps {
  readonly suite: Suite;
  readonly environment: EnvironmentInfo;
}

/**
 * A column is unavailable either because this browser cannot run the Engine, or because its Run has
 * already failed. Either way the reason is shown in the header and the Run moves on to the next
 * Configuration rather than abandoning the whole table.
 */
function toColumn(configuration: Configuration, environment: EnvironmentInfo, failure: string | undefined): GridColumn {
  if (failure !== undefined) {
    return {
      id: configuration.id,
      label: configuration.label,
      available: false,
      unavailableReason: failure,
      failed: true,
    };
  }
  const availability = configurationAvailability(configuration, environment);
  if (availability.available) {
    return { id: configuration.id, label: configuration.label, available: true };
  }
  return {
    id: configuration.id,
    label: configuration.label,
    available: false,
    unavailableReason: availability.reason ?? "unavailable",
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack !== undefined && error.stack.includes(error.message) ? error.stack : error.message;
  }
  return String(error);
}

export function SuiteSection({ suite, environment }: SuiteSectionProps): JSX.Element {
  const [setupSql, setSetupSql] = useState(suite.defaultSetupSql);
  const [cells, setCells] = useState<GridCells>({});
  const [running, setRunning] = useState(false);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  /** Per-Configuration Run failures, keyed by Configuration id. */
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  const grid: ResultsGrid = {
    rows: suite.benchmarks.map((benchmark) => ({ id: benchmark.id, label: benchmark.label })),
    columns: CONFIGURATIONS.map((configuration) => toColumn(configuration, environment, failures[configuration.id])),
    baselineColumnId: BASELINE_CONFIGURATION_ID,
    cells,
  };

  function recordFailure(configuration: Configuration, message: string): void {
    setFailures((previous) => ({ ...previous, [configuration.id]: message }));
    const line = `${configuration.label}: ${message}`;
    setError((previous) => (previous === null ? line : `${previous}\n\n${line}`));
  }

  async function start(): Promise<void> {
    setRunning(true);
    setError(null);
    setCopyStatus(null);
    setCells({});
    setFailures({});
    try {
      for (const configuration of CONFIGURATIONS) {
        if (!configurationAvailability(configuration, environment).available) {
          continue;
        }
        setActiveColumnId(configuration.id);
        try {
          // One Run per Configuration: a fresh worker, a fresh Engine, then the timed Benchmarks.
          await runSuite({
            suite,
            configuration,
            setupSql,
            onResult: (result) => {
              setCells((previous) => ({
                ...previous,
                [cellKey(result.configurationId, result.benchmarkId)]: result.elapsedMs,
              }));
            },
          });
        } catch (thrown) {
          // One Engine failing to open or to run must not cost the other Configurations their Run;
          // record it against this column and carry on.
          recordFailure(configuration, describeError(thrown));
        }
      }
    } catch (thrown) {
      setError(describeError(thrown));
    } finally {
      setActiveColumnId(null);
      setRunning(false);
    }
  }

  async function copyMarkdown(): Promise<void> {
    const markdown = toMarkdown(grid, {
      title: suite.title,
      environmentLine: formatEnvironmentLine(environment),
      baselineLabel: BASELINE_CONFIGURATION_LABEL,
    });
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyStatus("Copied.");
    } catch (thrown) {
      setCopyStatus(`Copy failed: ${describeError(thrown)}`);
    }
  }

  return (
    <section className="suite">
      <h2>{suite.title}</h2>
      <p className="description">{suite.description}</p>

      <div className="controls">
        {suite.editableSetup ? (
          <textarea
            aria-label="Pre-run setup"
            rows={2}
            cols={48}
            value={setupSql}
            disabled={running}
            onChange={(event) => {
              setSetupSql(event.target.value);
            }}
          />
        ) : null}
        <button
          type="button"
          disabled={running}
          onClick={() => {
            void start();
          }}
        >
          {running ? "Running…" : "Start"}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={() => {
            void copyMarkdown();
          }}
        >
          Copy as Markdown
        </button>
        {copyStatus === null ? null : <span className="copy-status">{copyStatus}</span>}
      </div>

      <pre className="error">{error ?? ""}</pre>

      <ResultsTable grid={grid} baselineLabel={BASELINE_CONFIGURATION_LABEL} activeColumnId={activeColumnId} />
    </section>
  );
}
