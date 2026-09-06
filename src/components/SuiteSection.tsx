import type { JSX } from "react";
import { useState } from "react";

import { applyConcurrencyClients, describeConcurrencyClientsOverride } from "../concurrency-clients";
import {
  BASELINE_CONFIGURATION_DIALECT,
  BASELINE_CONFIGURATION_ID,
  BASELINE_CONFIGURATION_LABEL,
  CONFIGURATIONS,
} from "../configurations";
import { suiteAvailability } from "../engines/availability";
import type { Configuration } from "../engines/contract";
import { configurationDialect } from "../engines/contract";
import type { EnvironmentInfo } from "../environment";
import { formatEnvironmentLine } from "../environment";
import type { GridCells, GridColumn, GridDetails, ResultsGrid } from "../results/grid";
import { cellKey } from "../results/grid";
import { toMarkdown } from "../results/markdown";
import { applyRttIterations, describeRttIterations } from "../rtt-iterations";
import { runSuite } from "../runner/run-suite";
import type { Suite } from "../suites/types";
import { ResultsTable } from "./ResultsTable";

export interface SuiteSectionProps {
  readonly suite: Suite;
  readonly environment: EnvironmentInfo;
}

/**
 * Where a Suite's Run has got to. Published as `data-state` so an automated lane can wait on the
 * DOM rather than on a timeout.
 */
type RunState = "idle" | "running" | "complete";

/**
 * A column is unavailable either because this browser cannot run the Engine, or because its Run has
 * already failed. Either way the reason is shown in the header and the Run moves on to the next
 * Configuration rather than abandoning the whole table.
 */
function toColumn(
  suite: Suite,
  configuration: Configuration,
  environment: EnvironmentInfo,
  failure: string | undefined,
): GridColumn {
  if (failure !== undefined) {
    return {
      id: configuration.id,
      label: configuration.label,
      available: false,
      unavailableReason: failure,
      failed: true,
    };
  }
  const availability = suiteAvailability(suite, configuration, environment);
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
  const [setupSql, setSetupSql] = useState(() => suite.initialSetupFor(BASELINE_CONFIGURATION_DIALECT));
  const [cells, setCells] = useState<GridCells>({});
  /** The Detail of the cells that have one; keyed exactly as the cells are. */
  const [details, setDetails] = useState<GridDetails>({});
  const [runState, setRunState] = useState<RunState>("idle");
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  /** Per-Configuration Run failures, keyed by Configuration id. */
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  /**
   * The untimed setup a Configuration's Run is opened with: whatever is in the textarea when the
   * Suite offers one, and otherwise the Suite's own setup in that Engine's dialect — which is the
   * only place a SQLite Engine needs different SQL from a Postgres one.
   */
  function setupFor(configuration: Configuration): string {
    return suite.editableSetup ? setupSql : suite.initialSetupFor(configurationDialect(configuration));
  }

  const running = runState === "running";
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
    columns: CONFIGURATIONS.map((configuration) =>
      toColumn(runnableSuite, configuration, environment, failures[configuration.id]),
    ),
    baselineColumnId: BASELINE_CONFIGURATION_ID,
    cells,
    details,
  };

  /** Recomputed every render, so the exported element and the clipboard can never disagree. */
  const markdown = toMarkdown(grid, {
    title: suite.title,
    environmentLine: formatEnvironmentLine(environment),
    baselineLabel: BASELINE_CONFIGURATION_LABEL,
    ...(runnableSuite.headerLine === undefined ? {} : { suiteLine: runnableSuite.headerLine }),
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
    setDetails({});
    setFailures({});
    try {
      for (const configuration of CONFIGURATIONS) {
        if (!suiteAvailability(runnableSuite, configuration, environment).available) {
          continue;
        }
        setActiveColumnId(configuration.id);
        try {
          // One Run per Configuration: a fresh worker, a fresh Engine, then the timed Benchmarks.
          await runSuite({
            suite: runnableSuite,
            configuration,
            setupSql: setupFor(configuration),
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

      <ResultsTable grid={grid} baselineLabel={BASELINE_CONFIGURATION_LABEL} activeColumnId={activeColumnId} />

      {/* Exactly what "Copy as Markdown" writes to the clipboard, exposed for the headless lane. */}
      <pre hidden data-testid={`markdown-${suite.id}`}>
        {markdown}
      </pre>
    </section>
  );
}
