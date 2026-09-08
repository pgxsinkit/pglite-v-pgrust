/**
 * Lay this repo's pgrust store engine down inside somebody else's app, as static files it can serve.
 *
 * **What the drop-in is.** pgxsinkit's board picks its local store through one build-time variable —
 * `VITE_BOARD_STORE_FACTORY=<absolute module URL>` — imports that module, and takes its default
 * export as the store factory (`apps/board/docs/local-store-seam.md`). `src/client/
 * pgrust-browser-factory.ts` is that module on this engine, and `bun run engine:build` bundles it
 * into ONE self-contained ESM file. This script copies that file plus the assets it loads at run
 * time into a directory the host app serves.
 *
 * **Why the shape is what it is.** The factory finds its own assets from `import.meta.url` — the
 * seam passes no asset base and will not grow one — so `./pgrust/` must sit beside the bundle:
 *
 *   <dir>/pgrust-store-factory.js          the seam module; its default export is the factory
 *   <dir>/pgrust/postgres-threads.wasm     the wasm32-wasip1-threads Postgres
 *   <dir>/pgrust/vfs.img, vfs.json         the packed image the store is seeded from
 *   <dir>/pgrust/host/*.js                 pgrust's own host runtime, loaded by URL, never bundled
 *   <dir>/pgrust/host/vendor/…             the repacked-store bundle the broker speaks to
 *   <dir>/pgrust/LICENSE, NOTICE           pgrust is AGPL-3.0; the notice travels with the binary
 *
 * **Same-origin, not negotiable.** The host runtime builds workers with `new Worker(url)`, which
 * refuses a cross-origin script, and the engine only constructs on a cross-origin-isolated page
 * (COOP `same-origin` + COEP `require-corp`), under which a cross-origin module would additionally
 * need CORS and `Cross-Origin-Resource-Policy: cross-origin`. Serving the whole directory from the
 * app's own origin — a vite `public/` subdirectory, say — sidesteps all of it, which is why this
 * script prints the URL it computed rather than leaving the caller to guess.
 *
 * Usage:
 *   bun run engine:package --into apps/board/public/store-engine
 *   bun run engine:package --into /srv/app/static/store-engine --origin https://app.example
 *   bun run engine:package --into … --no-build     # reuse dist/store-engine/
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Where `bun run engine:build` writes the bundle. */
const BUNDLE_DIR = resolve(REPO_ROOT, "dist/store-engine");
const BUNDLE_FILE = "pgrust-store-factory.js";
/** Where `bun run sync:pgrust` writes the build outputs the bundle loads at run time. */
const PUBLIC_PGRUST = resolve(REPO_ROOT, "public/pgrust");
/** The vendored host tree, which is where the AGPL notice for the wasm module lives. */
const VENDOR_PGRUST = resolve(REPO_ROOT, "src/vendor/pgrust");

const SYNC_HINT = "Run `bun run sync:pgrust` to lay the pgrust assets down.";
const BUILD_HINT = "Run `bun run engine:build` (or drop --no-build).";

/**
 * The three build outputs the factory fetches, by their name under `public/pgrust/`.
 *
 * `postgres.wasm` — the single-user `--stdio-wire` build the bench's other pgrust columns run — is
 * deliberately NOT here: a store is a postmaster, and 46 MB of a module nothing in this drop-in can
 * reach is 46 MB the host app would serve for nothing.
 */
const ENGINE_ASSETS: readonly string[] = ["postgres-threads.wasm", "vfs.img", "vfs.json"];

/**
 * The host runtime, served verbatim under `pgrust/host/`.
 *
 * Not bundled and not bundleable: the host builds its workers from URLs it computes at run time
 * (`threadWorkerUrl(base)`, `storageWorkerUrl(base)`), and a bundler would resolve their relative
 * imports against a hashed chunk name. `sync:pgrust` writes this directory; this copies it whole,
 * including `host/vendor/`, so the list stays in one place.
 */
const HOST_DIRECTORY = "host";

/** pgrust is AGPL-3.0: the complete-source statement travels with every copy of the binary. */
const LICENCE_FILES: readonly string[] = ["LICENSE", "NOTICE"];

interface Options {
  readonly into: string;
  readonly origin: string;
  readonly build: boolean;
}

const USAGE = `Usage: bun run engine:package --into <dir> [options]

  --into <dir>       Directory to write the drop-in into (created if missing). Required.
  --origin <url>     Origin the directory will be served from (default: http://localhost:5173)
  --no-build         Reuse dist/store-engine/ instead of rebuilding the bundle
  -h, --help         Print this message
`;

function parseOptions(argv: readonly string[]): Options {
  let into: string | undefined;
  let origin = "http://localhost:5173";
  let build = true;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    switch (flag) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
      case "--into": {
        index += 1;
        const value = argv[index];
        if (value === undefined) throw new Error("--into expects a directory");
        into = value;
        break;
      }
      case "--origin": {
        index += 1;
        const value = argv[index];
        if (value === undefined) throw new Error("--origin expects a URL");
        origin = value.replace(/\/+$/, "");
        break;
      }
      case "--no-build":
        build = false;
        break;
      default:
        throw new Error(`unknown argument "${flag}"\n\n${USAGE}`);
    }
  }
  if (into === undefined) {
    throw new Error(`--into is required\n\n${USAGE}`);
  }
  return { into: resolve(process.cwd(), into), origin, build };
}

/** Every file under `from`, copied into `to`, directories included. */
function copyTree(from: string, to: string): number {
  mkdirSync(to, { recursive: true });
  let files = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      files += copyTree(source, target);
    } else {
      copyFileSync(source, target);
      files += 1;
    }
  }
  return files;
}

function requireFile(path: string, hint: string): void {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. ${hint}`);
  }
}

function megabytes(path: string): string {
  return `${(statSync(path).size / 1_048_576).toFixed(1)} MiB`;
}

/**
 * The URL path a directory will be served at, when that can be known.
 *
 * A vite/`create-react-app`-shaped app serves everything under `public/` from its root, so a target
 * inside one has a knowable URL and the caller gets a line they can paste. Anything else gets the
 * shape rather than a guess — a wrong URL in `VITE_BOARD_STORE_FACTORY` fails at the first mint,
 * which is late.
 */
function servedPath(into: string): string | undefined {
  const marker = `${sep}public${sep}`;
  const at = into.lastIndexOf(marker);
  if (at === -1) return undefined;
  const tail = into
    .slice(at + marker.length)
    .split(sep)
    .join("/");
  return tail === "" ? "/" : `/${tail}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  if (options.build) {
    console.log("Building the store-engine bundle (bun run engine:build)…");
    const built = Bun.spawnSync(["bun", "run", "engine:build"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (built.exitCode !== 0) {
      throw new Error(`bun run engine:build exited with ${built.exitCode}`);
    }
  }

  const bundle = join(BUNDLE_DIR, BUNDLE_FILE);
  requireFile(bundle, BUILD_HINT);
  for (const asset of ENGINE_ASSETS) {
    requireFile(join(PUBLIC_PGRUST, asset), SYNC_HINT);
  }
  requireFile(join(PUBLIC_PGRUST, HOST_DIRECTORY, "threads-host.js"), SYNC_HINT);
  requireFile(join(PUBLIC_PGRUST, HOST_DIRECTORY, "vendor", "pglite-opfs-repacked.js"), SYNC_HINT);

  // The asset tree is replaced wholesale rather than merged: a stale `vfs.img` beside a new wasm
  // module is a store that boots and then fails on a catalog it does not recognise.
  const assetRoot = join(options.into, "pgrust");
  rmSync(assetRoot, { recursive: true, force: true });
  mkdirSync(assetRoot, { recursive: true });

  copyFileSync(bundle, join(options.into, BUNDLE_FILE));
  for (const asset of ENGINE_ASSETS) {
    copyFileSync(join(PUBLIC_PGRUST, asset), join(assetRoot, asset));
  }
  const hostFiles = copyTree(join(PUBLIC_PGRUST, HOST_DIRECTORY), join(assetRoot, HOST_DIRECTORY));
  for (const notice of LICENCE_FILES) {
    const source = join(VENDOR_PGRUST, notice);
    if (existsSync(source)) copyFileSync(source, join(assetRoot, notice));
  }

  console.log("");
  console.log(`Packaged the pgrust store engine into ${relative(process.cwd(), options.into) || "."}`);
  console.log(`  ${BUNDLE_FILE.padEnd(24)} ${megabytes(join(options.into, BUNDLE_FILE))}`);
  for (const asset of ENGINE_ASSETS) {
    console.log(`  pgrust/${asset.padEnd(17)} ${megabytes(join(assetRoot, asset))}`);
  }
  console.log(`  pgrust/host/             ${hostFiles} files`);

  const path = servedPath(options.into);
  console.log("");
  if (path === undefined) {
    console.log("Serve that directory from the app's OWN origin, then point the board's seam at the bundle:");
    console.log("");
    console.log("  VITE_BOARD_STORE_FACTORY=<origin><path-the-directory-is-served-at>/pgrust-store-factory.js");
  } else {
    console.log("Point the board's local-store seam at it:");
    console.log("");
    console.log(`  VITE_BOARD_STORE_FACTORY=${options.origin}${path}/${BUNDLE_FILE}`);
  }
  console.log("  VITE_BOARD_ISOLATED=1");
  console.log("");
  console.log("Both are read at BUILD time (or dev-server start). The second serves COOP/COEP, which the");
  console.log("threads build needs and without which the factory refuses to construct.");
}

await main();
