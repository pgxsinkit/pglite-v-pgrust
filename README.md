# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against [PGlite](https://pglite.dev) and
[pgrust](https://github.com/pgxsinkit/pgrust) — two WebAssembly Postgres builds — and reports the
timings side by side.

Two Suites are ported unchanged from PGlite's own benchmark pages:

- **Speedtest Suite** — the 16 SQL scripts ported from the SQLite speed test via
  [wa-sqlite](https://github.com/rhashimoto/wa-sqlite), byte-identical to PGlite's copies. One timing
  per script.
- **RTT Suite** — twelve single-statement CRUD queries, 100 iterations each, top and bottom 10% of
  timings discarded, mean of the rest.

Each Engine runs in its own dedicated module worker, and every timing is taken **inside** that worker
around the Engine call alone — the main-thread messaging is deliberately outside the measured window.
Results are shown per Configuration (an Engine plus its storage and durability settings), with a ratio
column against the `PGlite Memory` baseline and a "Copy as Markdown" button per Suite.

Times are milliseconds; lower is better.

## Prerequisites

- [mise](https://mise.jdx.dev) for tool versions, which pins Bun and Node for this repo:

  ```sh
  mise install
  ```

- Bun 1.4 (installed by the step above).

## Getting started

```sh
bun install
bun run dev      # http://localhost:5580
```

To build and serve the production bundle:

```sh
bun run build
bun run preview
```

Both Suites are started from the page — nothing runs until you press **Start**. Each Run opens a fresh
Engine in a fresh worker, so no state carries over between Configurations.

## pgrust assets

PGlite installs from npm; pgrust does not. Its host JavaScript is vendored into this repo and its
~90 MB wasm build assets are copied in from a local pgrust checkout, so the `pgrust Memory` column
needs one setup step.

Build the assets in the pgrust checkout:

```sh
cd ../pgrust
PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh   # compiles postgres.wasm
wasm/build.sh                                         # packs vfs.img + vfs.json beside it
```

Then sync them into this repo:

```sh
bun run sync:pgrust                 # vendored host JS + public/pgrust/ assets
bun run sync:pgrust --vendor-only   # host JS only; skips the assets
PGRUST_DIR=/path/to/pgrust bun run sync:pgrust   # non-sibling checkout
```

The script copies `pgrust-wasi.js`, `wiresession.js`, `wire.js`, `LICENSE` and `NOTICE` into
`src/vendor/pgrust/` (committed), writes the synced commit to `src/vendor/pgrust/VERSION` — which the
environment header reports — and copies `postgres.wasm`, `vfs.img` and `vfs.json` into `public/pgrust/`
(gitignored, ~90 MB). Run it again after every pgrust rebuild. Without the assets the app still builds
and the PGlite columns still run; the pgrust column reports the fetch failure in its header.

### Browser requirements

pgrust runs a single long-lived `postgres --stdio-wire` instance and suspends the guest on its
blocking stdin read, which needs **JS Promise Integration** (`WebAssembly.Suspending` plus
`WebAssembly.promising`):

| Browser        | JSPI        | pgrust column    |
| -------------- | ----------- | ---------------- |
| Chrome / Edge  | 137+        | runs             |
| Firefox        | 153+        | runs             |
| Safari         | 27+         | runs             |
| Anything older | unavailable | reported skipped |

The header shows whether JSPI was detected. Where it is missing the pgrust column is greyed out with
that reason and the PGlite columns run as normal — no Run is aborted for it.

## Development & contributing

Scripts are check-default: a bare verb never mutates files.

| Script                 | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `bun run dev`          | Vite dev server on port 5580                     |
| `bun run build`        | Production build into `dist/`                    |
| `bun run preview`      | Serve the production build                       |
| `bun run format`       | oxfmt, check only                                |
| `bun run format:write` | oxfmt, rewrite files                             |
| `bun run lint`         | oxlint (type-aware), check only                  |
| `bun run lint:fix`     | oxlint with autofixes applied                    |
| `bun run typecheck`    | `tsc --noEmit`                                   |
| `bun run test`         | `bun test src` — unit tests only                 |
| `bun run check`        | typecheck + lint + test                          |
| `bun run validate`     | format + check; installed as the pre-commit hook |
| `bun run sync:pgrust`  | Vendor pgrust's host JS and copy its wasm assets |

`bun install` runs `prepare`, which points `core.hooksPath` at `.githooks/`, so `bun run validate`
gates every commit.

Everything in `src/` is TypeScript with one sanctioned exception: `src/vendor/pgrust/*.js` is copied
**byte-verbatim** from a pgrust checkout by `bun run sync:pgrust` (provenance in
`src/vendor/pgrust/SOURCE.md`). Those files must never be edited, reformatted or linted here — pgrust
is upstream, and any change would silently fork the thing being benchmarked — so `src/vendor/` is in
the `ignorePatterns` of both `.oxlintrc.jsonc` and `.oxfmtrc.jsonc`. The `.d.ts` files beside them are
ours, hand-written, and are what makes the vendored JavaScript type-check under `allowJs: false`.

Adding an Engine is additive: write `src/engines/<engine>/<engine>.worker.ts` against the message
protocol in `src/engines/protocol.ts`, register its worker factory in `src/engines/registry.ts`, and
add its Configuration to `src/configurations.ts`. Whether a Configuration can run is decided at
runtime in `src/engines/availability.ts` rather than stored on the Configuration; a Configuration that
cannot run, or whose Run fails, greys out its own column and leaves the others alone.

The Speedtest Suite's `.sql` files are held byte-identical to PGlite's copies;
`src/suites/speedtest/speedtest.test.ts` proves it when a PGlite checkout is present (point
`PGLITE_BENCHMARK_SRC` at one, or let the test skip).

Vocabulary used throughout the code and UI — Engine, Configuration, Suite, Benchmark, Measurement,
Run — is defined in [CONTEXT.md](CONTEXT.md).

## Attributions

- The benchmark workloads originate in the
  [wa-sqlite benchmarks](https://rhashimoto.github.io/wa-sqlite/demo/benchmarks.html), Copyright 2021
  Roy T. Hashimoto, MIT licensed.
- They were adapted for Postgres by the [PGlite](https://github.com/electric-sql/pglite) authors
  (ElectricSQL), Apache-2.0 licensed; the SQL and statement lists here are byte-identical ports of
  PGlite's copies.
- [pgrust](https://github.com/pgxsinkit/pgrust) is AGPL-3.0 licensed. Its browser host JavaScript is
  vendored byte-verbatim under `src/vendor/pgrust/`, together with its `LICENSE` and `NOTICE`; the
  synced commit is recorded in `src/vendor/pgrust/SOURCE.md`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
