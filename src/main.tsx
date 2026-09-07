import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import {
  readConfigurationSelection,
  selectionNeedsCorrection,
  writeConfigurationSelection,
} from "./configuration-selection";
import { readEnvironment } from "./environment";
import { installIdleProbe } from "./idle-probe";
import { installMemoryProbe } from "./memory-probe";
import { installPreparedStoreProbe } from "./prepared-store-probe";

import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Missing #root element");
}

/**
 * The environment is read before the first render, not during it: detecting whether an OPFS
 * synchronous access handle can be opened means opening one in a worker, and a header — or a column
 * header — that corrects itself a moment after the page loads is a header an automated lane can
 * read at the wrong moment.
 */
const environment = await readEnvironment();

/**
 * The memory probe's handle, published before the first render and used by nothing on the page: it
 * exists so `scripts/probe-memory.ts` can run one Configuration at a time and ask the Engine's
 * worker how much wasm memory it is holding. Registering it costs one property on `globalThis`.
 */
installMemoryProbe(environment);

/**
 * The idle probe's handle, published beside it and used by nothing on the page either: it exists so
 * `scripts/probe-idle-cpu.ts` and `scripts/probe-idle-cpu-android.ts` can open one Engine, warm it,
 * and then leave it standing while the browser and the OS say what an idle tab with a database in it
 * costs. Another property on `globalThis`, and nothing else.
 */
installIdleProbe(environment);

/**
 * The prepared-store probe's handle, published beside the other two and used by nothing on the page.
 * `scripts/probe-prepared-store.ts` drives it: one tarball of four store files against one PGlite
 * datadir tarball, the same datadir either way, timed from "the bytes arrived" to "the database
 * answered". A third property on `globalThis`.
 */
installPreparedStoreProbe(environment);

/**
 * Which Configurations this page compares, and which of them the ratios are taken against.
 *
 * Resolved here rather than in a component for the same reason the environment is: it depends on
 * what this browser can run, and the table's columns have to be settled before the table is drawn.
 * A URL that asked for something it did not get — an id that names nothing, a Configuration this
 * browser cannot run, a Baseline outside the selection — is corrected on the spot, so the link in
 * the address bar always describes the page under it.
 */
const selection = readConfigurationSelection(environment);
if (selectionNeedsCorrection(selection)) {
  writeConfigurationSelection(selection.selectedIds, selection.baselineId);
}

createRoot(container).render(
  <StrictMode>
    <App environment={environment} selection={selection} />
  </StrictMode>,
);
