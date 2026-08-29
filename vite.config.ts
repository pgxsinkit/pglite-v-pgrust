import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * An Engine version stamped into the environment header, read from the package's own manifest.
 * Neither `@pgxsinkit/pglite` nor `wa-sqlite` exports `./package.json`, so resolve the entry point
 * and walk up to the manifest beside it.
 */
function readDependencyVersion(specifier: string, manifestFromEntry: string): string {
  try {
    const entry = createRequire(import.meta.url).resolve(specifier);
    const manifest: unknown = JSON.parse(readFileSync(resolve(dirname(entry), manifestFromEntry), "utf8"));
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = (manifest as { version: unknown }).version;
      if (typeof version === "string") {
        return version;
      }
    }
  } catch {
    // Fall through to "unknown": a missing version must not break the build.
  }
  return "unknown";
}

/** Written by `bun run sync:pgrust`; absent until pgrust has been vendored. */
function readPgrustVersion(): string {
  const versionFile = resolve(rootDir, "src/vendor/pgrust/VERSION");
  if (!existsSync(versionFile)) {
    return "not synced";
  }
  const version = readFileSync(versionFile, "utf8").trim();
  return version === "" ? "not synced" : version;
}

export default defineConfig({
  plugins: [react()],
  define: {
    __PGLITE_VERSION__: JSON.stringify(readDependencyVersion("@pgxsinkit/pglite", "../package.json")),
    __PGRUST_VERSION__: JSON.stringify(readPgrustVersion()),
    // `wa-sqlite`'s entry point is `src/sqlite-api.js`; its manifest is the directory above.
    __WASQLITE_VERSION__: JSON.stringify(readDependencyVersion("wa-sqlite", "../package.json")),
  },
  // PGlite ships its own wasm/data assets and must not be pre-bundled.
  optimizeDeps: {
    exclude: ["@pgxsinkit/pglite"],
  },
  worker: {
    format: "es",
  },
  build: {
    // The Speedtest Suite inlines ~11 MB of byte-identical SQL; the size is the point, not a warning.
    chunkSizeWarningLimit: 20_000,
    // Every Engine needs a current browser anyway (pgrust needs JSPI); downlevelling the vendored
    // pgrust host JS would only risk changing what is being benchmarked.
    target: "esnext",
  },
  server: {
    port: 5580,
  },
  preview: {
    port: 5580,
  },
});
