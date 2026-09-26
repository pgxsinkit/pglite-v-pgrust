/**
 * The store tables `?brokerStats=1` adds to a Suite's Markdown export, under the results table: one
 * row per Benchmark per Configuration, the Warm-up first, Benchmark-major so one Benchmark's
 * Configurations sit together.
 *
 * Three tables, each only over the Configurations that have its part (`./store-stats.ts`):
 *
 * - **pgrust guest file calls** — every pgrust Configuration. A kind's cell is `calls · ms`, the ms
 *   being every guest thread's time inside those calls; then the bytes read and written, and the ms
 *   in file calls of the Session backend and of every thread.
 * - **Broker** — the broker Configurations: the requests the coordinator answered by kind, the
 *   Session backend's and every thread's ms blocked in file calls (on this seam, waiting on the
 *   coordinator), the coordinator's own ms answering, and both per request.
 * - **OPFS access handles** — every OPFS Configuration, PGlite's included: `calls · ms` by kind, and
 *   the bytes read and written.
 *
 * A row is the sum over every Measurement of its Benchmark, which is a Measurement for every Suite
 * but the RTT Suite, whose rows are each statement run N times.
 */

import type { GridColumn, GridStoreStats, ResultsGrid } from "./grid";
import { cellKey, readCell, readWarmup } from "./grid";
import type { StoreKindTotals, StoreStats } from "./store-stats";
import { BROKER_KINDS, GUEST_KINDS, HANDLE_KINDS, totalOf } from "./store-stats";

/** The line every store section opens with, and the switch it names. */
export const STORE_STATS_HEADING = "#### Store work (`broker stats: on`)";

/** One store table's row: which Benchmark, which Configuration, its cell, and its store work. */
interface StoreRow {
  readonly benchmark: string;
  readonly column: GridColumn;
  readonly elapsedMs: number | undefined;
  readonly stats: StoreStats;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Milliseconds in these tables: two decimals, enough for a sum of in-memory calls. */
function ms(value: number): string {
  return value.toFixed(2);
}

function kib(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

function count(value: number): string {
  return String(Math.round(value));
}

/** One kind's `calls · ms`, or `0` for a kind that was never called. */
function callsAndMs(totals: StoreKindTotals): string {
  return totals.calls === 0 ? "0" : `${count(totals.calls)} · ${ms(totals.ms)}`;
}

/** µs per request, or `–` without a request to divide by. */
function perRequest(totalMs: number, requests: number): string {
  return requests === 0 ? "–" : ((totalMs * 1000) / requests).toFixed(0);
}

/** Every counted row of the grid: the Warm-up's first, then each Benchmark's, in column order. */
function storeRows(grid: ResultsGrid): readonly StoreRow[] {
  const rows: StoreRow[] = [];
  const add = (benchmark: string, column: GridColumn, elapsedMs: number | undefined, stats: StoreStats | undefined) => {
    if (stats !== undefined) {
      rows.push({ benchmark, column, elapsedMs, stats });
    }
  };
  const warmup = grid.warmup;
  if (warmup !== undefined) {
    const byColumn: GridStoreStats = warmup.storeStats ?? {};
    for (const column of grid.columns) {
      add(warmup.label, column, readWarmup(grid, column.id), byColumn[column.id]);
    }
  }
  const byCell: GridStoreStats = grid.storeStats ?? {};
  for (const gridRow of grid.rows) {
    for (const column of grid.columns) {
      add(gridRow.label, column, readCell(grid.cells, column.id, gridRow.id), byCell[cellKey(column.id, gridRow.id)]);
    }
  }
  return rows;
}

function table(header: readonly string[], body: readonly (readonly string[])[]): readonly string[] {
  return [row(header), row(header.map(() => "---")), ...body.map(row)];
}

function lead(storeRow: StoreRow): readonly string[] {
  return [
    escapeCell(storeRow.benchmark),
    escapeCell(storeRow.column.label),
    storeRow.elapsedMs === undefined ? "–" : storeRow.elapsedMs.toFixed(3),
  ];
}

function guestTable(rows: readonly StoreRow[]): readonly string[] {
  const body = rows.flatMap((storeRow) => {
    const guest = storeRow.stats.guest;
    if (guest === undefined) {
      return [];
    }
    return [
      [
        ...lead(storeRow),
        ...GUEST_KINDS.map((kind) => callsAndMs(guest.all[kind])),
        kib(guest.all.read.bytes),
        kib(guest.all.write.bytes),
        ms(totalOf(GUEST_KINDS, guest.backend).ms),
        ms(totalOf(GUEST_KINDS, guest.all).ms),
      ],
    ];
  });
  if (body.length === 0) {
    return [];
  }
  return [
    "",
    "##### pgrust guest file calls",
    "",
    "Every WASI file call the guest made, by kind: `calls · ms`, the ms being every guest thread's time " +
      "inside those calls. On a broker seam that time is the thread blocked on the coordinator; on the copy " +
      "seam and on the single-session build it is the in-memory filesystem's own. The Session backend is " +
      "the thread that reads the Session's input.",
    "",
    ...table(
      [
        "Benchmark",
        "Configuration",
        "Measurement (ms)",
        ...GUEST_KINDS.map((kind) => `${kind} (calls · ms)`),
        "KiB read",
        "KiB written",
        "ms in file calls: Session backend",
        "ms in file calls: every thread",
      ],
      body,
    ),
  ];
}

function brokerTable(rows: readonly StoreRow[]): readonly string[] {
  const body = rows.flatMap((storeRow) => {
    const { broker, guest } = storeRow.stats;
    if (broker === undefined) {
      return [];
    }
    const requests = BROKER_KINDS.reduce((sum, kind) => sum + broker.requests[kind], 0);
    const backendMs = guest === undefined ? 0 : totalOf(GUEST_KINDS, guest.backend).ms;
    const allMs = guest === undefined ? 0 : totalOf(GUEST_KINDS, guest.all).ms;
    return [
      [
        ...lead(storeRow),
        ...BROKER_KINDS.map((kind) => count(broker.requests[kind])),
        count(requests),
        guest === undefined ? "–" : kib(guest.all.read.bytes),
        guest === undefined ? "–" : kib(guest.all.write.bytes),
        ms(backendMs),
        ms(allMs),
        ms(broker.servingMs),
        perRequest(allMs, requests),
        perRequest(broker.servingMs, requests),
      ],
    ];
  });
  if (body.length === 0) {
    return [];
  }
  return [
    "",
    "##### Broker",
    "",
    "The requests the coordinator answered, by kind; the bytes the guest read and wrote through it; the ms " +
      "the Session backend and every guest thread spent blocked in file calls; the ms the coordinator spent " +
      "answering; and both per request (µs), the difference being the hand-off.",
    "",
    ...table(
      [
        "Benchmark",
        "Configuration",
        "Measurement (ms)",
        ...BROKER_KINDS.map((kind) => `${kind} requests`),
        "requests",
        "KiB read",
        "KiB written",
        "blocked ms: Session backend",
        "blocked ms: every thread",
        "coordinator serving ms",
        "µs per request: blocked",
        "µs per request: serving",
      ],
      body,
    ),
  ];
}

function handleTable(rows: readonly StoreRow[]): readonly string[] {
  const body = rows.flatMap((storeRow) => {
    const handles = storeRow.stats.handles;
    if (handles === undefined) {
      return [];
    }
    return [
      [
        ...lead(storeRow),
        ...HANDLE_KINDS.map((kind) => callsAndMs(handles[kind])),
        kib(handles.read.bytes),
        kib(handles.write.bytes),
        ms(totalOf(HANDLE_KINDS, handles).ms),
      ],
    ];
  });
  if (body.length === 0) {
    return [];
  }
  return [
    "",
    "##### OPFS access handles",
    "",
    "Every synchronous access handle call the store made, by kind: `calls · ms`. PGlite's store makes them " +
      "in its own worker, pgrust's in the storage coordinator; the same code counts both.",
    "",
    ...table(
      [
        "Benchmark",
        "Configuration",
        "Measurement (ms)",
        ...HANDLE_KINDS.map((kind) => `${kind} (calls · ms)`),
        "KiB read",
        "KiB written",
        "ms in handle calls",
      ],
      body,
    ),
  ];
}

/**
 * The store section of a Suite's export, or nothing on a Run that counted nothing.
 *
 * `measurementsPerBenchmark` is how many Measurements each Benchmark's row sums — the RTT Suite's
 * iteration count, and 1 for the rest — so a row can be read against its cell.
 */
export function storeStatsMarkdown(grid: ResultsGrid, measurementsPerBenchmark: number): readonly string[] {
  const rows = storeRows(grid);
  if (rows.length === 0) {
    return [];
  }
  const summed =
    measurementsPerBenchmark === 1
      ? "Each row is one Measurement's store work."
      : `Each Benchmark's row is the sum over its ${measurementsPerBenchmark} Measurements (the Warm-up's is one); ` +
        "its Measurement column is the cell, which is not.";
  return [
    "",
    STORE_STATS_HEADING,
    "",
    `${summed} The counters are read before and after each Measurement, outside its window; what ` +
      "counting costs inside the store calls themselves is in the Measurement.",
    ...guestTable(rows),
    ...brokerTable(rows),
    ...handleTable(rows),
  ];
}
