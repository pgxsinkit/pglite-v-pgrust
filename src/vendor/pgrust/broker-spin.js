// broker-spin.js — an optional, bounded spin before either side of the `--fs broker` seam parks.
//
// THE HAND-OFF. One broker request is two futex hand-offs (wasm/broker-fs.js, wasm/storage-worker.js):
// the guest thread publishes its request on its channel and rings the doorbell, the coordinator —
// parked in `Atomics.wait` on the doorbell's ticket — wakes, answers, publishes the reply and
// notifies the channel's state word, and the guest — parked in `Atomics.wait` on that word — wakes.
// pglite-v-pgrust's `?brokerStats=1` splits a request into what the guest was blocked and what the
// coordinator spent answering; the difference is the hand-off, and on a phone (OnePlus, Android 10,
// Chrome 153) it was 100–300 µs a request, 5–7× the desktop's.
//
// THE SPIN (`spinUs`, 0 = off, which installs nothing and is exactly the behaviour before it). Before
// either side parks, it polls the word it is about to wait on for up to `spinUs` microseconds and
// does not park at all if the word moves in that time:
//
//   guest         after ringing the doorbell, its own channel's state word, until the reply lands
//                 (`installReplySpin`, from wasm/broker-fs.js);
//   coordinator   after a scan of every channel found nothing to answer, the doorbell's ticket,
//                 until the next request rings (`installRequestSpin`, from wasm/storage-worker.js).
//
// A spin that runs out falls through to the very wait that would have run without it, on the same
// word with the same value, so nothing about the protocol changes and no wakeup can be missed: the
// word was read before the spin, and a change during it is exactly what ends it early.
//
// BOUNDED PER WAIT, NEVER ACROSS IDLE TIME. Each spin is at most `spinUs` and then the agent parks as
// before. The guest only ever spins while its own request is in flight. The coordinator spins once
// after each scan that found nothing — which, between requests, is how the next one is caught
// without a futex wake — and NOT after a park that timed out: a coordinator whose last park ran its
// whole poll interval with no request is idle, and it parks straight away until a ring wakes it. So
// an idle coordinator burns at most one spin per idle period, not a core.
//
// ONE WORD PER AGENT, KEPT. Every channel rings the one doorbell, so the coordinator watches one
// word whether it spins or parks, the same shape as sab-pipe.js's host gate (one wait per agent,
// never one per ring: the WebKit freeze the 2026-09-08 Safari concurrency note describes). A guest
// watches only its own channel. Neither side gains a waiter it did not have.
//
// THE CLOCK. `performance.now()`, read once every POLLS_PER_CLOCK polls so the loop between two
// reads is nothing but atomic loads. A cross-origin isolated page coarsens it to a few µs, which is
// the resolution of the bound, not of the poll: the word is re-read on every iteration.

/** The largest spin a host accepts, in µs. A millisecond is past any request this seam serves. */
export const MAX_BROKER_SPIN_US = 1000;

// The broker protocol's own constants (@pgxsinkit/pglite-opfs-repacked `broker/protocol.ts`). The
// bundle does not export them; wasm/io-stats.js reads the same two.
const HEADER_STATE = 0;
const STATE_REQUEST = 1;
const DOORBELL_TICKET = 0;

// Atomic loads between two clock reads.
const POLLS_PER_CLOCK = 16;

// Marks a doorbell object that already carries a spin, so one can never be wrapped twice.
const SPINNING = Symbol('broker-spin');

/**
 * A host's spin setting as a whole number of µs: 0 for absent, null or 0, and a RangeError for
 * anything that is not an integer in 0..MAX_BROKER_SPIN_US — a typo must not become a busy loop.
 */
export function normalizeSpinUs(value) {
  if (value === undefined || value === null || value === 0) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_BROKER_SPIN_US) {
    throw new RangeError(`broker spin must be an integer from 0 to ${MAX_BROKER_SPIN_US} µs, got ${value}`);
  }
  return value;
}

/**
 * Poll `word[index]` while it still holds `value`, for at most `us` µs. True the moment it moved,
 * false when the time ran out with it unchanged (the caller then parks exactly as it would have).
 */
export function spinWhileEqual(word, index, value, us) {
  const deadline = performance.now() + us / 1000;
  for (let polls = 1; ; polls += 1) {
    if (Atomics.load(word, index) !== value) return true;
    if (polls % POLLS_PER_CLOCK === 0 && performance.now() >= deadline) return false;
  }
}

function claim(doorbell) {
  if (doorbell[SPINNING]) throw new Error('this broker doorbell already carries a spin');
  doorbell[SPINNING] = true;
}

/**
 * The guest's half: after every request this client rings for, spin on the channel's state word
 * until the reply lands or `spinUs` runs out. `channel` is the ATTACHED `RepackedChannel` the
 * client was built on.
 *
 * The library's `RepackedSyncClient` rings the doorbell and then waits on the state word for as long
 * as it still says REQUEST; the ring is the one seam between the two, so the spin goes there. A
 * reply that lands during the spin leaves the state word at RESPONSE, and the client's own wait
 * loop then never parks. `RepackedChannel.attach` gives every attached channel a doorbell object of
 * its own, so this reaches this one client and nothing else in the agent.
 */
export function installReplySpin(channel, spinUs) {
  const us = normalizeSpinUs(spinUs);
  if (us === 0) return false;
  const doorbell = channel.doorbell;
  claim(doorbell);
  const header = channel.header;
  const ring = doorbell.ring.bind(doorbell);
  doorbell.ring = () => {
    ring();
    spinWhileEqual(header, HEADER_STATE, STATE_REQUEST, us);
  };
  return true;
}

/**
 * The coordinator's half: before its serve loop parks on the doorbell, spin on the ticket until a
 * request rings or `spinUs` runs out — unless its last park timed out, which means it is idle (see
 * BOUNDED PER WAIT above). `doorbell` is the coordinator's own attached `RepackedDoorbell`, the one
 * its `RepackedSyncBroker` was built with: `serveForever()` calls `this.doorbell.wait(observed,
 * pollIntervalMs)` and ignores the answer, so a spin that saw a ring returns `not-equal`, which is
 * what `Atomics.wait` itself answers for a word that had already moved.
 */
export function installRequestSpin(doorbell, spinUs) {
  const us = normalizeSpinUs(spinUs);
  if (us === 0) return false;
  claim(doorbell);
  const ticket = new Int32Array(doorbell.buffer, 0, DOORBELL_TICKET + 1);
  const wait = doorbell.wait.bind(doorbell);
  let idle = false;
  doorbell.wait = (observed, timeoutMs) => {
    if (!idle && spinWhileEqual(ticket, DOORBELL_TICKET, observed, us)) return 'not-equal';
    const outcome = wait(observed, timeoutMs);
    idle = outcome === 'timed-out';
    return outcome;
  };
  return true;
}
