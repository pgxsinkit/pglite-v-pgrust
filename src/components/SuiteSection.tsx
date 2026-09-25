import type { JSX } from "react";
import { useState } from "react";

import { applyConcurrencyClients, describeConcurrencyClientsOverride } from "../concurrency-clients";
import { describeConfigurationSelection } from "../configuration-selection";
import { BASELINE_CONFIGURATION_DIALECT, CONFIGURATIONS } from "../configurations";
import { configurationAvailability } from "../engines/availability";
import type { Configuration } from "../engines/contract";
import { configurationDialect } from "../engines/contract";
import type { EngineStats } from "../engines/protocol";
import type { EnvironmentInfo } from "../environment";
import { formatEnvironmentLine } from "../environment";
import type { GridCells, GridColumn, GridDetails, ResultsGrid } from "../results/grid";
import { cellKey } from "../results/grid";
import { toMarkdown } from "../results/markdown";
import { applyRttIterations, describeRttIterations } from "../rtt-iterations";
import { runSuite } from "../runner/run-suite";
import type { Suite } from "../suites/types";
import { suiteUnsupportedReason } from "../suites/types";
import { WARMUP_EXPORT_LINE, WARMUP_LABEL } from "../suites/warmup";
import { WARMUP_SQL } from "../suites/warmup-sql";
import { ResultsTable } from "./ResultsTable";

export interface SuiteSectionProps {
  readonly suite: Suite;
  readonly environment: EnvironmentInfo;
  /** The Configurations this Run compares, in column order: whatever the page has ticked. */
  readonly configurations: readonly Configuration[];
  /**
   * The column every ratio is taken against. Null only when nothing at all is selected, which is a
   * table with no columns and therefore nothing to take a ratio against.
   */
  readonly baseline: Configuration | null;
}

/**
 * Where a Suite's Run has got to. Published as `data-state` so an automated lane can wait on the
 * DOM rather than on a timeout.
 */
type RunState = "idle" | "running" | "complete";

/**
 * A column is unavailable because this Suite does not run on its Engine at all (the Prepared Suite on
 * wa-sqlite), because this browser cannot run the Engine, or because its Run has already failed.
 * Whichever it is, the reason is shown in the header and the Run moves on to the next Configuration
 * rather than abandoning the whole table.
 *
 * The Suite's note travels with the column whatever its state: a skipped Concurrency column still
 * says which kind of concurrency it would have had, which is what makes the reason beside it read as
 * a browser's answer rather than the Engine's.
 */
function toColumn(
  suite: Suite,
  configuration: Configuration,
  environment: EnvironmentInfo,
  failure: string | undefined,
): GridColumn {
  const note = suite.columnNoteFor?.(configuration.engine);
  const named = {
    id: configuration.id,
    label: configuration.label,
    ...(note === undefined ? {} : { note }),
  };
  if (failure !== undefined) {
    return { ...named, available: false, unavailableReason: failure, failed: true };
  }
  const unsupported = suiteUnsupportedReason(suite, configurationDialect(configuration));
  if (unsupported !== undefined) {
    return { ...named, available: false, unavailableReason: unsupported };
  }
  const availability = configurationAvailability(configuration, environment);
  if (availability.available) {
    return { ...named, available: true };
  }
  return { ...named, available: false, unavailableReason: availability.reason ?? "unavailable" };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack !== undefined && error.stack.includes(error.message) ? error.stack : error.message;
  }
  return String(error);
}

export function SuiteSection({ suite, environment, configurations, baseline }: SuiteSectionProps): JSX.Element {
  // Seeded from the Baseline the page opened with, and left alone afterwards: a reader who has typed
  // into the textarea must not have it rewritten under them by a click on another Baseline radio.
  const [setupSql, setSetupSql] = useState(() =>
    suite.initialSetupFor(baseline === null ? BASELINE_CONFIGURATION_DIALECT : configurationDialect(baseline)),
  );
  const [cells, setCells] = useState<GridCells>({});
  /**
   * Each Configuration's Warm-up, keyed by Configuration id: the line above the Benchmarks, kept
   * out of `cells` so it can never be counted as one of them.
   */
  const [warmupCells, setWarmupCells] = useState<GridCells>({});
  /** The Detail of the cells that have one; keyed exactly as the cells are. */
  const [details, setDetails] = useState<GridDetails>({});
  const [runState, setRunState] = useState<RunState>("idle");
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  /** Per-Configuration Run failures, keyed by Configuration id. */
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  /**
   * What each Configuration's Engine said it was holding at the end of its Run, keyed by
   * Configuration id.
   *
   * It is in the DOM rather than in the table because it is not a Measurement: a WebDriver lane
   * (Safari has no CDP, so a memory probe cannot reach into the page the way the headless lane
   * does) can read only what the page publishes, and the size of a shared `WebAssembly.Memory` is
   * the one number that says how much of a phone's per-tab budget a Run actually claimed.
   */
  const [engineStats, setEngineStats] = useState<Readonly<Record<string, EngineStats>>>({});

  /**
   * The untimed setup a Configuration's Run is opened with: whatever is in the textarea when the
   * Suite offers one, and otherwise the Suite's own setup in that Engine's dialect — which is the
   * only place a SQLite Engine needs different SQL from a Postgres one.
   */
  function setupFor(configuration: Configuration): string {
    return suite.editableSetup ? setupSql : suite.initialSetupFor(configurationDialect(configuration));
  }

  const running = runState === "running";
  /** What the ratio headers say they are relative to; empty only when there is no column at all. */
  const baselineLabel = baseline?.label ?? "";
  /**
   * The Suite as run: identical to `suite` unless a URL asked for fewer RTT iterations or another
   * number of Concurrency Clients. Both rewrite the Suite rather than the Run, and both say so.
   */
  const runnableSuite = applyConcurrencyClients(
    applyRttIterations(suite, environment.rttIterationsOverride),
    environment.concurrencyClientsOverride,
  );
  const nonStandardIterations = runnableSuite.iterations !== suite.iterations;
  const nonStandardClients = suite.id === "concurrency" && environment.concurrencyClientsOverride !== null;

  const grid: ResultsGrid = {
    // The runnable Suite's rows, not the declared Suite's: a Concurrency Run with another Client
    // count has other labels, and the table has to be the table that was run.
    rows: runnableSuite.benchmarks.map((benchmark) => ({ id: benchmark.id, label: benchmark.label })),
    columns: configurations.map((configuration) =>
      toColumn(runnableSuite, configuration, environment, failures[configuration.id]),
    ),
    baselineColumnId: baseline?.id ?? "",
    cells,
    details,
    warmup: { label: WARMUP_LABEL, cells: warmupCells },
  };

  /** Recomputed every render, so the exported element and the clipboard can never disagree. */
  const markdown = toMarkdown(grid, {
    title: suite.title,
    environmentLine: formatEnvironmentLine(environment),
    // Taken from the grid itself rather than from the props, so the line and the table it heads
    // cannot name different columns.
    selectionLine: describeConfigurationSelection(
      grid.columns.map((column) => column.id),
      grid.baselineColumnId === "" ? null : grid.baselineColumnId,
      CONFIGURATIONS.length,
    ),
    baselineLabel,
    ...(runnableSuite.headerLine === undefined ? {} : { suiteLine: runnableSuite.headerLine }),
    warmupLine: WARMUP_EXPORT_LINE,
  });

  function recordFailure(configuration: Configuration, message: string): void {
    setFailures((previous) => ({ ...previous, [configuration.id]: message }));
    const line = `${configuration.label}: ${message}`;
    setError((previous) => (previous === null ? line : `${previous}\n\n${line}`));
  }

  async function start(): Promise<void> {
    setRunState("running");
    setError(null);
    setCopyStatus(null);
    setCells({});
    setWarmupCells({});
    setDetails({});
    setFailures({});
    setEngineStats({});
    try {
      for (const configuration of configurations) {
        if (
          suiteUnsupportedReason(runnableSuite, configurationDialect(configuration)) !== undefined ||
          !configurationAvailability(configuration, environment).available
        ) {
          continue;
        }
        setActiveColumnId(configuration.id);
        try {
          // One Run per Configuration: a fresh worker, a fresh Engine, its timed Warm-up, the
          // untimed setup, then the timed Benchmarks.
          await runSuite({
            suite: runnableSuite,
            configuration,
            setupSql: setupFor(configuration),
            warmupSql: WARMUP_SQL,
            onWarmup: (result) => {
              setWarmupCells((previous) => ({ ...previous, [result.configurationId]: result.elapsedMs }));
            },
            onStats: (configurationId, stats) => {
              setEngineStats((previous) => ({ ...previous, [configurationId]: stats }));
            },
            onResult: (result) => {
              setCells((previous) => ({
                ...previous,
                [cellKey(result.configurationId, result.benchmarkId)]: result.elapsedMs,
              }));
              const detail = result.detail;
              if (detail !== undefined) {
                setDetails((previous) => ({
                  ...previous,
                  [cellKey(result.configurationId, result.benchmarkId)]: detail,
                }));
              }
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
      setRunState("complete");
    }
  }

  async function copyMarkdown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyStatus("Copied.");
    } catch (thrown) {
      setCopyStatus(`Copy failed: ${describeError(thrown)}`);
    }
  }

  return (
    <section className="suite" data-testid={`suite-${suite.id}`} data-suite-id={suite.id} data-state={runState}>
      <h2>{suite.title}</h2>
      <p className="description">{runnableSuite.description}</p>
      {nonStandardIterations ? (
        <p className="non-standard-note">{describeRttIterations(runnableSuite.iterations)}</p>
      ) : null}
      {nonStandardClients && environment.concurrencyClientsOverride !== null ? (
        <p className="non-standard-note">
          {describeConcurrencyClientsOverride(environment.concurrencyClientsOverride)}
        </p>
      ) : null}

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
          data-testid={`start-${suite.id}`}
          disabled={running}
          onClick={() => {
            void start();
          }}
        >
          {running ? "Running…" : "Start"}
        </button>
        <button
          type="button"
          data-testid={`copy-markdown-${suite.id}`}
          disabled={running}
          onClick={() => {
            void copyMarkdown();
          }}
        >
          Copy as Markdown
        </button>
        {copyStatus === null ? null : <span className="copy-status">{copyStatus}</span>}
      </div>

      <pre className="error" data-testid={`error-${suite.id}`}>
        {error ?? ""}
      </pre>

      <ResultsTable grid={grid} baselineLabel={baselineLabel} activeColumnId={activeColumnId} />

      {/* Exactly what "Copy as Markdown" writes to the clipboard, exposed for the headless lane. */}
      <pre hidden data-testid={`markdown-${suite.id}`}>
        {markdown}
      </pre>

      {/* Not a Measurement: what each Engine held at the end of its Run, for a lane with no CDP. */}
      <pre hidden data-testid={`engine-stats-${suite.id}`}>
        {JSON.stringify(engineStats)}
      </pre>
    </section>
  );
}
