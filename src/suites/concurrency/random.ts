/**
 * The Concurrency Suite's key sequence: pseudo-random, and identical everywhere.
 *
 * Every key every Client reads or updates is drawn here, from a fixed seed, on the main thread, and
 * written into the Scenario as a literal. Two things follow, and both are the point:
 *
 * - **Every Engine sees the same statements.** A column whose keys came from `random()` in the
 *   database would be a different workload per Engine, and the table would compare nothing.
 * - **A Run is repeatable.** The same page reloaded, or the same Suite run against another
 *   Configuration ten minutes later, reads the same rows in the same order.
 *
 * `mulberry32` because it is four lines, has no dependencies and is far better distributed than
 * anything worth writing instead; nothing here needs cryptographic randomness.
 */

/** The seed. Any fixed value would do; what matters is that it never changes between columns. */
export const CONCURRENCY_SEED = 0x5eed_c0de;

export interface Random {
  /** The next value in [0, 1). */
  next(): number;
  /** The next integer in [min, max], inclusive. */
  nextInt(min: number, max: number): number;
}

export function createRandom(seed: number = CONCURRENCY_SEED): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    nextInt: (min, max) => min + Math.floor(next() * (max - min + 1)),
  };
}
