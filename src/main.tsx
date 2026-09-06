import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { readEnvironment } from "./environment";

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

createRoot(container).render(
  <StrictMode>
    <App environment={environment} />
  </StrictMode>,
);
