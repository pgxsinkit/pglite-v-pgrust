import { CONCURRENCY_SUITE } from "./concurrency";
import { PREPARED_SUITE } from "./prepared";
import { RTT_SUITE } from "./rtt";
import { SPEEDTEST_SUITE } from "./speedtest";

/** Every Suite, in page order; the Prepared Suite last, so the three older lanes run as they did. */
export const SUITES = [SPEEDTEST_SUITE, RTT_SUITE, CONCURRENCY_SUITE, PREPARED_SUITE] as const;
