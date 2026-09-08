import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Connect, Plugin } from "vite";
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

/**
 * Cross-origin isolation, on every server that serves this page.
 *
 * `SharedArrayBuffer` and a shared `WebAssembly.Memory` are gated on `crossOriginIsolated`, and the
 * pgrust threads build is nothing but those two: its guest threads block in `Atomics.wait` on
 * SharedArrayBuffer ring pipes over one shared memory. Without both headers the browser withholds
 * `SharedArrayBuffer` entirely and the two threads columns can only report themselves skipped.
 *
 * Nothing this page loads is cross-origin — PGlite, wa-sqlite and the pgrust assets are all served
 * from here — so `require-corp` costs the other eight columns nothing. The same pair is set by
 * `scripts/bench.ts`'s static server, because the headless lane serves `dist/` itself.
 */
const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * The path prefix this build is served under: `BASE_PATH`, `/` by default.
 *
 * Everything the page fetches at run time is addressed through `import.meta.env.BASE_URL` — the
 * pgrust wasm and vfs image, the vendored host JS the two threads Engines `import()` by URL, every
 * worker — so one value here moves all of them. GitHub Pages serves a project site from
 * `/<repo>/`, which is why this is a variable rather than a constant: `BASE_PATH=/pglite-v-pgrust/
 * bun run build` produces the deployable tree, and a bare `bun run build` still produces the
 * root-served one the local lanes use.
 */
function basePath(): string {
  const configured = process.env["BASE_PATH"]?.trim() ?? "";
  if (configured === "" || configured === "/") {
    return "/";
  }
  const leading = configured.startsWith("/") ? configured : `/${configured}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

/** The service worker file name, at the base's root so its scope covers the whole app. */
const COI_SERVICE_WORKER_FILE = "coi-serviceworker.js";

/** The unminified `coi-serviceworker`, which carries its own MIT banner. */
function readCoiServiceWorker(): string {
  return readFileSync(createRequire(import.meta.url).resolve(`coi-serviceworker/${COI_SERVICE_WORKER_FILE}`), "utf8");
}

/**
 * Serve `coi-serviceworker.js` from the base's root, on every server this config owns.
 *
 * GitHub Pages cannot set a response header, and the two headers above are the only way a browser
 * hands out `SharedArrayBuffer`. `coi-serviceworker` closes that gap from inside the page: a service
 * worker that re-serves every response with the pair, at the cost of one reload on the first visit.
 * `index.html` registers it only where `crossOriginIsolated` is already `false`, so `bun run dev`,
 * `bun run preview` and the bench lane — all of which send the real headers — never install it.
 *
 * It is emitted as a plain top-level asset rather than imported, because a service worker's scope is
 * the directory it is served from: hashed into `assets/` it could not control `index.html`, and
 * `Service-Worker-Allowed` is another header Pages will not send. Copied out of `node_modules` at
 * build time so the dependency is the source of truth and no vendored copy can drift from it.
 */
function coiServiceWorker(): Plugin {
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (!path.endsWith(`/${COI_SERVICE_WORKER_FILE}`)) {
      next();
      return;
    }
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(readCoiServiceWorker());
  };
  return {
    name: "coi-serviceworker",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: COI_SERVICE_WORKER_FILE, source: readCoiServiceWorker() });
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

export default defineConfig({
  base: basePath(),
  plugins: [react(), coiServiceWorker()],
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
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  preview: {
    port: 5580,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
});
