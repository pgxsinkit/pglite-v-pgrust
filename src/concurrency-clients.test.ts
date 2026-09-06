import { describe, expect, test } from "bun:test";

import {
  applyConcurrencyClients,
  CONCURRENCY_CLIENTS_PARAM,
  describeConcurrencyClientsOverride,
  MAX_CONCURRENCY_CLIENTS,
  MIN_CONCURRENCY_CLIENTS,
  parseConcurrencyClients,
} from "./concurrency-clients";
import { CONCURRENCY_CLIENTS, CONCURRENCY_SUITE } from "./suites/concurrency";
import { RTT_SUITE } from "./suites/rtt";
import { suiteSessions } from "./suites/types";

describe("parseConcurrencyClients", () => {
  test("reads an integer in range", () => {
    expect(parseConcurrencyClients(`?${CONCURRENCY_CLIENTS_PARAM}=6`)).toBe(6);
    expect(parseConcurrencyClients(`?${CONCURRENCY_CLIENTS_PARAM}=${MIN_CONCURRENCY_CLIENTS}`)).toBe(
      MIN_CONCURRENCY_CLIENTS,
    );
    expect(parseConcurrencyClients(`?${CONCURRENCY_CLIENTS_PARAM}=${MAX_CONCURRENCY_CLIENTS}`)).toBe(
      MAX_CONCURRENCY_CLIENTS,
    );
  });

  // A mistyped URL must leave the page running the standard Suite rather than blanking it.
  test("ignores anything that is not an integer in range", () => {
    for (const search of [
      "",
      "?other=4",
      `?${CONCURRENCY_CLIENTS_PARAM}=`,
      `?${CONCURRENCY_CLIENTS_PARAM}=0`,
      `?${CONCURRENCY_CLIENTS_PARAM}=1`,
      `?${CONCURRENCY_CLIENTS_PARAM}=${MAX_CONCURRENCY_CLIENTS + 1}`,
      `?${CONCURRENCY_CLIENTS_PARAM}=2.5`,
      `?${CONCURRENCY_CLIENTS_PARAM}=four`,
      `?${CONCURRENCY_CLIENTS_PARAM}=-2`,
    ]) {
      expect(parseConcurrencyClients(search)).toBeNull();
    }
  });
});

describe("applyConcurrencyClients", () => {
  test("rebuilds the Concurrency Suite for the count that was asked for", () => {
    const rebuilt = applyConcurrencyClients(CONCURRENCY_SUITE, 6);
    expect(suiteSessions(rebuilt)).toBe(6);
    expect(rebuilt.benchmarks).toHaveLength(CONCURRENCY_SUITE.benchmarks.length);
  });

  test("says in the Suite's own header line that the count is non-standard", () => {
    expect(applyConcurrencyClients(CONCURRENCY_SUITE, 6).headerLine).toBe("Concurrency clients: 6 (non-standard)");
    expect(describeConcurrencyClientsOverride(6)).toBe("Concurrency clients: 6 (non-standard)");
  });

  test("leaves the Suite alone without an override, or when the override is the standard count", () => {
    expect(applyConcurrencyClients(CONCURRENCY_SUITE, null)).toBe(CONCURRENCY_SUITE);
    expect(applyConcurrencyClients(CONCURRENCY_SUITE, CONCURRENCY_CLIENTS)).toBe(CONCURRENCY_SUITE);
  });

  test("touches no other Suite", () => {
    expect(applyConcurrencyClients(RTT_SUITE, 6)).toBe(RTT_SUITE);
  });
});
