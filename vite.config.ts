import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * The Engine version stamped into the environment header. `@pgxsinkit/pglite` does not export
 * `./package.json`, so resolve its entry point and read the manifest beside it.
 */
function readPgliteVersion(): string {
  try {
    const entry = createRequire(import.meta.url).resolve("@pgxsinkit/pglite");
    const manifest: unknown = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8"));
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

/** Written by `bun run sync:pgrust`; absent until the pgrust Engine is wired up. */
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
    __PGLITE_VERSION__: JSON.stringify(readPgliteVersion()),
    __PGRUST_VERSION__: JSON.stringify(readPgrustVersion()),
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
  },
  server: {
    port: 5580,
  },
  preview: {
    port: 5580,
  },
});
