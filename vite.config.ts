import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { describeDependencyVersion } from "./src/dependency-version";

const rootDir = dirname(fileURLToPath(import.meta.url));

/** A field of a package manifest, or undefined if the manifest cannot be read or lacks it. */
function readManifestString(manifestPath: string, ...path: readonly string[]): string | undefined {
  try {
    let value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const key of path) {
      if (typeof value !== "object" || value === null || !(key in value)) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[key];
    }
    return typeof value === "string" ? value : undefined;
  } catch {
    // A missing or malformed manifest must not break the build.
    return undefined;
  }
}

/**
 * A dependency version stamped into the environment header.
 *
 * None of these packages exports `./package.json`, so resolve the entry point and walk up to the
 * manifest beside it. What is reported is then decided by `describeDependencyVersion`: for a git
 * dependency the pinned ref in our own specifier wins over that manifest, because a tagged tree's
 * manifest can lag the tag — wa-sqlite's `v1.1.2` still says `1.1.1` inside — and for an `npm:`
 * alias the aliased target's version wins, because the installed package is not the one the
 * dependency key names.
 */
function readDependencyVersion(name: string, manifestFromEntry: string): string {
  const specifier = readManifestString(resolve(rootDir, "package.json"), "dependencies", name);
  let manifestVersion = "unknown";
  try {
    const entry = createRequire(import.meta.url).resolve(name);
    manifestVersion = readManifestString(resolve(dirname(entry), manifestFromEntry), "version") ?? "unknown";
  } catch {
    // Fall through to "unknown": a dependency we cannot resolve must not break the build.
  }
  return describeDependencyVersion(specifier, manifestVersion);
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
    // Installed under the upstream name through an `npm:` alias, so the store package and this app
    // resolve one single PGlite: the pgx fork. The header still reports what is really installed.
    __PGLITE_VERSION__: JSON.stringify(readDependencyVersion("@electric-sql/pglite", "../package.json")),
    __OPFS_REPACKED_VERSION__: JSON.stringify(
      readDependencyVersion("@pgxsinkit/pglite-opfs-repacked", "../package.json"),
    ),
    __PGRUST_VERSION__: JSON.stringify(readPgrustVersion()),
    // `wa-sqlite`'s entry point is `src/sqlite-api.js`; its manifest is the directory above. It is
    // installed from a GitHub tag, so what lands here is the tag, not that manifest's version.
    __WASQLITE_VERSION__: JSON.stringify(readDependencyVersion("wa-sqlite", "../package.json")),
  },
  // PGlite ships its own wasm/data assets and must not be pre-bundled. The store package is
  // excluded with it, because it imports PGlite: pre-bundling one half of that pair while excluding
  // the other is how a dev server ends up serving two PGlites.
  optimizeDeps: {
    exclude: ["@electric-sql/pglite", "@pgxsinkit/pglite-opfs-repacked"],
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
