// Based on wa-sqlite's benchmarks.
// Copyright 2021 Roy T. Hashimoto. All Rights Reserved.
// Modified by the PGLite authors.
// Ported by pglite-v-pgrust.

import type { Suite } from "../types";
import { PREPARED_SQL } from "./sql";
import { buildPreparedSuite } from "./suite";

/**
 * The Speedtest's statement-heavy rows sent as one `PREPARE` per shape followed by an `EXECUTE` per
 * statement, so a Benchmark measures a reused plan. One timing per row.
 */
export const PREPARED_SUITE: Suite = buildPreparedSuite(PREPARED_SQL);
