import type { JSX } from "react";

import type { EnvironmentInfo } from "../environment";
import { formatEnvironmentLine } from "../environment";
import { describePgrustModule } from "../pgrust-module";
import { describeRttIterations } from "../rtt-iterations";

export interface EnvironmentHeaderProps {
  readonly environment: EnvironmentInfo;
}

/**
 * Which pgrust build each module is: one commit for both, unless `?pgrustModule=` swapped the
 * threads module for an alternate, in which case the two are named apart.
 */
function describePgrustModules(environment: EnvironmentInfo): string {
  if (environment.pgrustModule === null) {
    return `${environment.pgrustVersion} (postgres.wasm + postgres-threads.wasm)`;
  }
  return `${environment.pgrustVersion} (postgres.wasm) + ${environment.pgrustModule} (postgres-threads.wasm, alternate)`;
}

function describeOpfsSyncAccess(environment: EnvironmentInfo): string {
  if (environment.opfsSyncAccessAvailable) {
    return "available";
  }
  return environment.opfsSyncAccessReason === null
    ? "unavailable"
    : `unavailable (${environment.opfsSyncAccessReason})`;
}

export function EnvironmentHeader({ environment }: EnvironmentHeaderProps): JSX.Element {
  return (
    <>
      <dl className="environment">
        <div>
          <dt>Browser</dt>
          <dd>{environment.userAgent}</dd>
        </div>
        <div>
          <dt>@pgxsinkit/pglite</dt>
          <dd>{environment.pgliteVersion}</dd>
        </div>
        <div>
          <dt>@pgxsinkit/pglite-opfs-repacked</dt>
          <dd>{environment.opfsRepackedVersion}</dd>
        </div>
        <div className={environment.pgrustModule === null ? undefined : "non-standard"}>
          {/* One commit, two wasm modules: the pgrust columns and the pgrust Threads columns are the
              same source tree built for two targets, so there is only ever one commit to name —
              unless `?pgrustModule=` swapped the threads module, and then there are two. */}
          <dt>pgrust</dt>
          <dd>{describePgrustModules(environment)}</dd>
        </div>
        <div>
          <dt>wa-sqlite</dt>
          <dd>{environment.wasqliteVersion}</dd>
        </div>
        <div>
          <dt>JSPI</dt>
          <dd>{environment.jspiAvailable ? "available" : "unavailable"}</dd>
        </div>
        <div>
          {/* The browser's own answer: true only when COOP and COEP both arrived. */}
          <dt>Cross-origin isolated</dt>
          <dd>{environment.crossOriginIsolated ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>OPFS sync access</dt>
          {/* The probe's own words when it was refused: what the store hit, not what we assumed. */}
          <dd>{describeOpfsSyncAccess(environment)}</dd>
        </div>
        {environment.rttIterationsOverride === null ? null : (
          <div className="non-standard">
            <dt>RTT iterations</dt>
            <dd>{`${environment.rttIterationsOverride} (non-standard)`}</dd>
          </div>
        )}
      </dl>
      {/* The exact line every Markdown export carries, exposed verbatim for the headless lane. */}
      <pre hidden data-testid="environment-line">
        {formatEnvironmentLine(environment)}
      </pre>
      {environment.rttIterationsOverride === null ? null : (
        <p className="non-standard-note">{describeRttIterations(environment.rttIterationsOverride)}</p>
      )}
      {environment.pgrustModule === null ? null : (
        <p className="non-standard-note" data-testid="pgrust-module-note">
          {`${describePgrustModule(environment.pgrustModule)}: the six pgrust Threads and Postmaster columns load ` +
            `this pgrust build's threads module instead of ${environment.pgrustVersion}'s.`}
        </p>
      )}
    </>
  );
}
