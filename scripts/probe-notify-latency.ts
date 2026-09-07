/**
 * How long a cross-session `NOTIFY` takes to reach a listening client.
 *
 * `bun run probe:notify`
 *
 * The `pgxsinkit-live` scenario answers a different question. There, one session both writes and
 * listens, so the `NotificationResponse` comes back inline on the writing statement's own reply and
 * the number it prints is a round trip. **This** probe is the two-session shape the split needs:
 * session A does `LISTEN probe` and then sits idle, session B notifies from its own backend, and
 * what is measured is the gap between B's statement returning and A's listener callback firing.
 *
 * That gap is the guest's, not the transport's. A pgrust wasm backend with nothing to do is parked
 * in a 100 ms poll on its host pipe and processes interrupts between polls, so an idle listener
 * learns about a notification when its poll next wakes. The expected shape of the answer is
 * therefore a spread from ~0 to ~100 ms with a median near half of that, and the point of running it
 * is to see the real distribution rather than to reason about it.
 *
 * Two variants, 50 rounds each, at least 20 ms apart:
 *
 *  1. **direct** — B runs `NOTIFY probe, '<payload>'`;
 *  2. **trigger** — B inserts a row into a table carrying a statement-level plpgsql trigger that
 *     calls `pg_notify`, which is the shape PGlite's `live` extension creates.
 *
 * And each variant at two cadences, because the first cadence alone lies. With a **fixed** gap
 * between rounds the loop phase-locks to the guest's poll — every round starts the same distance
 * after the wakeup that ended the previous one, so the sample is one point of the distribution
 * repeated fifty times and looks far more stable than the thing it measures. The **swept** cadence
 * walks the gap from 20 ms to 110 ms in ten steps, which lands the rounds at every phase of a 100 ms
 * poll and is the honest picture. Both are reported.
 *
 * A is idle between rounds, so it only sees anything at all because
 * {@link PgrustPGlite.pumpNotifications} is running on it — the opt-in idle pump this probe is the
 * first caller of.
 *
 * Exit 0 on `VERDICT: notify-latency PASS`, exit 1 with the reason on FAIL.
 */

import { startPgrustPostmaster, type PgrustEngine } from "../src/client/pgrust-engine";
import { PgrustPGlite } from "../src/client/pgrust-pglite";

/** Rounds per variant, per cadence. */
const ROUNDS = 50;
/** The floor on the gap between rounds, so a round never rides on the previous one's wakeup. */
const MIN_ROUND_GAP_MS = 20;
/** The swept cadence's step, ten of which cover one 100 ms guest poll. */
const SWEEP_STEP_MS = 10;
const SWEEP_STEPS = 10;
/** How long one round's notification has to arrive before the round is recorded as lost. */
const ROUND_DEADLINE_MS = 5_000;
/** The channel both variants notify on; the payload says which round and which variant it is. */
const CHANNEL = "probe";

interface Variant {
  readonly id: string;
  readonly label: string;
  /** The payload the round's notification will carry; `seq` is unique across the whole probe. */
  readonly payload: (seq: number) => string;
  /** The statement B runs for the round. */
  readonly sql: (seq: number) => string;
}

const VARIANTS: readonly Variant[] = [
  {
    id: "direct",
    label: "NOTIFY from session B",
    payload: (seq) => `d${seq}`,
    sql: (seq) => `notify ${CHANNEL}, 'd${seq}'`,
  },
  {
    id: "trigger",
    label: "INSERT + statement trigger calling pg_notify (the live shape)",
    payload: (seq) => `t${seq}`,
    sql: (seq) => `insert into probe_rows (id, payload) values (${seq}, 't${seq}')`,
  },
];

/**
 * The trigger variant's schema: PGlite's `live` extension in miniature — one statement-level AFTER
 * trigger whose function calls `pg_notify` on the channel the client listens on. The transition
 * table is the one liberty taken: `live` notifies with an empty payload and re-queries, and this
 * probe has to be able to say which round a notification belongs to.
 */
const TRIGGER_SCHEMA = `
create table probe_rows (id int primary key, payload text not null);

create function probe_rows_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('${CHANNEL}', (select max(payload) from new_rows));
  return null;
end;
$$;

create trigger probe_rows_notify_trigger
  after insert on probe_rows
  referencing new table as new_rows
  for each statement execute function probe_rows_notify();
`;

/** How long the probe waits before starting the next round. */
interface Cadence {
  readonly id: string;
  readonly label: string;
  readonly gapMs: (round: number) => number;
}

const CADENCES: readonly Cadence[] = [
  {
    id: "fixed",
    label: `fixed ${MIN_ROUND_GAP_MS} ms`,
    gapMs: () => MIN_ROUND_GAP_MS,
  },
  {
    id: "swept",
    label: `swept ${MIN_ROUND_GAP_MS}–${MIN_ROUND_GAP_MS + (SWEEP_STEPS - 1) * SWEEP_STEP_MS} ms`,
    gapMs: (round) => MIN_ROUND_GAP_MS + (round % SWEEP_STEPS) * SWEEP_STEP_MS,
  },
];

interface VariantResult {
  readonly variant: Variant;
  readonly cadence: Cadence;
  /** One latency per delivered round, in arrival order. */
  readonly latenciesMs: readonly number[];
  readonly lost: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The nearest-rank percentile of an already-sorted sample. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
}

interface Summary {
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

function summarize(latencies: readonly number[]): Summary {
  const sorted = [...latencies].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: percentile(sorted, 0),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: percentile(sorted, 1),
    mean: sorted.length === 0 ? Number.NaN : sum / sorted.length,
  };
}

function format(value: number): string {
  return Number.isNaN(value) ? "—" : value.toFixed(1);
}

/**
 * The listener side: one callback, and a promise per payload the probe is waiting for.
 *
 * A payload that arrives before anyone asks for it is remembered, so a notification that beats the
 * `await` on B's own statement (which is possible: the backend commits before it answers) is not a
 * lost round.
 */
class Arrivals {
  readonly #arrived = new Map<string, number>();
  readonly #waiting = new Map<string, (at: number) => void>();

  record(payload: string): void {
    const at = performance.now();
    const waiter = this.#waiting.get(payload);
    if (waiter) {
      this.#waiting.delete(payload);
      waiter(at);
      return;
    }
    this.#arrived.set(payload, at);
  }

  /** Resolves with the arrival timestamp, or null when the deadline passes first. */
  async wait(payload: string, deadlineMs: number): Promise<number | null> {
    const already = this.#arrived.get(payload);
    if (already !== undefined) {
      this.#arrived.delete(payload);
      return already;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<number | null>((resolve) => {
        this.#waiting.set(payload, resolve);
        timer = setTimeout(() => {
          this.#waiting.delete(payload);
          resolve(null);
        }, deadlineMs);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The round counter, unique across every variant and cadence so no two payloads are ever equal. */
let nextSeq = 0;

async function runVariant(
  notifier: PgrustPGlite,
  arrivals: Arrivals,
  variant: Variant,
  cadence: Cadence,
): Promise<VariantResult> {
  const latenciesMs: number[] = [];
  let lost = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round > 0) {
      await delay(cadence.gapMs(round));
    }
    const seq = nextSeq;
    nextSeq += 1;
    const payload = variant.payload(seq);
    await notifier.exec(variant.sql(seq));
    // B's statement has committed and answered: from here on the only thing left is A's own backend
    // noticing, which is the whole quantity under measurement.
    const committedAt = performance.now();
    const arrivedAt = await arrivals.wait(payload, ROUND_DEADLINE_MS);
    if (arrivedAt === null) {
      lost += 1;
      continue;
    }
    latenciesMs.push(Math.max(0, arrivedAt - committedAt));
  }
  return { variant, cadence, latenciesMs, lost };
}

function renderTable(results: readonly VariantResult[]): string {
  const header = "| Variant | Cadence | delivered | lost | min (ms) | median (ms) | p95 (ms) | max (ms) | mean (ms) |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = results.map((result) => {
    const summary = summarize(result.latenciesMs);
    return (
      `| ${result.variant.label} | ${result.cadence.label} | ${result.latenciesMs.length}/${ROUNDS} | ${result.lost} | ` +
      `${format(summary.min)} | ${format(summary.median)} | ${format(summary.p95)} | ` +
      `${format(summary.max)} | ${format(summary.mean)} |`
    );
  });
  return [header, rule, ...rows].join("\n");
}

async function main(): Promise<void> {
  let engine: PgrustEngine | undefined;
  let listener: PgrustPGlite | undefined;
  let notifier: PgrustPGlite | undefined;
  const pump = new AbortController();
  let pumping: Promise<void> | undefined;

  try {
    const bootStart = performance.now();
    engine = await startPgrustPostmaster({ sessions: 2 });
    log(`pgrust postmaster ready in ${(performance.now() - bootStart).toFixed(0)} ms`);

    const sessionStart = performance.now();
    listener = await PgrustPGlite.create(engine.openSession(), { applicationName: "probe-notify-listener" });
    notifier = await PgrustPGlite.create(engine.openSession(), { applicationName: "probe-notify-notifier" });
    log(`two pgwire sessions + PGlite clients ready in ${(performance.now() - sessionStart).toFixed(0)} ms`);

    // Nothing else in this repo starts the pump; without it session A is idle and blind.
    pumping = listener.pumpNotifications(pump.signal);

    const arrivals = new Arrivals();
    await listener.listen(CHANNEL, (payload) => {
      arrivals.record(payload);
    });
    await notifier.exec(TRIGGER_SCHEMA);
    log(`session A is listening on "${CHANNEL}"; session B owns the trigger table`);

    const results: VariantResult[] = [];
    for (const variant of VARIANTS) {
      for (const cadence of CADENCES) {
        const start = performance.now();
        const result = await runVariant(notifier, arrivals, variant, cadence);
        log(`${variant.id} / ${cadence.id}: ${ROUNDS} rounds in ${((performance.now() - start) / 1000).toFixed(1)} s`);
        results.push(result);
      }
    }

    log("");
    log(renderTable(results));
    log("");

    pump.abort();
    await pumping;
    pumping = undefined;

    await listener.close();
    listener = undefined;
    await notifier.close();
    notifier = undefined;

    const stop = await engine.shutdown();
    engine = undefined;
    log(
      `pgrust postmaster stopped in ${stop.shutdownMs.toFixed(0)} ms ` +
        `(exit ${stop.exitCode}, shutdown checkpoint ${stop.checkpointed ? "ran" : "did NOT run"})`,
    );
    if (stop.exitCode !== 0) {
      throw new Error(`the pgrust postmaster exited with code ${stop.exitCode}`);
    }

    const lost = results.reduce((total, result) => total + result.lost, 0);
    if (lost > 0) {
      throw new Error(`${lost} of ${ROUNDS * VARIANTS.length * CADENCES.length} notifications never arrived`);
    }
    log("VERDICT: notify-latency PASS");
  } catch (error: unknown) {
    log(`VERDICT: notify-latency FAIL — ${describe(error)}`);
    pump.abort();
    await pumping?.catch(() => {});
    await listener?.close().catch(() => {});
    await notifier?.close().catch(() => {});
    await engine?.shutdown().catch(() => {});
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

await main();
