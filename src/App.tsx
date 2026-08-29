import type { JSX } from "react";

import { EnvironmentHeader } from "./components/EnvironmentHeader";
import { SuiteSection } from "./components/SuiteSection";
import { readEnvironment } from "./environment";
import { SUITES } from "./suites";

/** Read once at module scope: the environment does not change while the page is open. */
const ENVIRONMENT = readEnvironment();

export function App(): JSX.Element {
  return (
    <main>
      <h1>pglite-v-pgrust</h1>
      <p>
        The same SQL workloads run against two WebAssembly Postgres builds, timed inside each Engine&apos;s worker.
        Lower is better; times are milliseconds.
      </p>
      <EnvironmentHeader environment={ENVIRONMENT} />
      {SUITES.map((suite) => (
        <SuiteSection key={suite.id} suite={suite} environment={ENVIRONMENT} />
      ))}
    </main>
  );
}
