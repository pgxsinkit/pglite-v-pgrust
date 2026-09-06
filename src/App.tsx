import type { JSX } from "react";

import { EnvironmentHeader } from "./components/EnvironmentHeader";
import { SuiteSection } from "./components/SuiteSection";
import type { EnvironmentInfo } from "./environment";
import { SUITES } from "./suites";

export interface AppProps {
  /**
   * Read once, before the first render, and never again: the environment does not change while the
   * page is open, and one of its capabilities can only be detected asynchronously — so it is
   * awaited in `main.tsx` and handed in, rather than filled in under a rendered header.
   */
  readonly environment: EnvironmentInfo;
}

export function App({ environment }: AppProps): JSX.Element {
  return (
    <main>
      <h1>pglite-v-pgrust</h1>
      <p>
        The same SQL workloads run against two WebAssembly Postgres builds, with wa-sqlite alongside them as a
        calibration reference, timed inside each Engine&apos;s worker. Lower is better; times are milliseconds.
      </p>
      <EnvironmentHeader environment={environment} />
      {SUITES.map((suite) => (
        <SuiteSection key={suite.id} suite={suite} environment={environment} />
      ))}
    </main>
  );
}
