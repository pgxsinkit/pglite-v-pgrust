/**
 * Hand-written types for the vendored `broker-spin.js`: the broker's optional spin before parking,
 * on both sides of the `--fs broker` seam. A guest polls its channel for its reply, and the
 * coordinator the doorbell for the next request, for up to N µs before it parks in `Atomics.wait`;
 * bounded per wait, and the coordinator skips it after a park that timed out, so an idle coordinator
 * does not spin.
 *
 * Ours, not pgrust's. It declares only what this repo touches: the bound, which
 * `src/broker-switches.ts` keeps in step with (`?brokerSpin=`), and the host's own check of a value.
 * The hosts install the spin themselves from the `brokerSpinUs` they are handed.
 */

/** The largest spin the host accepts, in µs. */
export declare const MAX_BROKER_SPIN_US: number;

/** A spin as whole µs: 0 for absent, null or 0; a `RangeError` for anything outside 0..MAX_BROKER_SPIN_US. */
export declare function normalizeSpinUs(value: number | null | undefined): number;
