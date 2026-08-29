import type { JSX } from "react";

import type { EnvironmentInfo } from "../environment";
import { formatEnvironmentLine } from "../environment";
import { describeRttIterations } from "../rtt-iterations";

export interface EnvironmentHeaderProps {
  readonly environment: EnvironmentInfo;
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
          <dt>pgrust</dt>
          <dd>{environment.pgrustVersion}</dd>
        </div>
        <div>
          <dt>JSPI</dt>
          <dd>{environment.jspiAvailable ? "available" : "unavailable"}</dd>
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
    </>
  );
}
