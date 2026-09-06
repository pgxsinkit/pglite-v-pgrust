import { CONCURRENCY_SUITE } from "./concurrency";
import { RTT_SUITE } from "./rtt";
import { SPEEDTEST_SUITE } from "./speedtest";

export const SUITES = [SPEEDTEST_SUITE, RTT_SUITE, CONCURRENCY_SUITE] as const;
