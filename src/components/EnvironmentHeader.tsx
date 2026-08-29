import type { JSX } from "react";

import type { EnvironmentInfo } from "../environment";

export interface EnvironmentHeaderProps {
  readonly environment: EnvironmentInfo;
}

export function EnvironmentHeader({ environment }: EnvironmentHeaderProps): JSX.Element {
  return (
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
    </dl>
  );
}
