# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against [PGlite](https://pglite.dev) and
[pgrust](https://github.com/pgxsinkit/pgrust) — two WebAssembly Postgres builds — and reports the
timings side by side, with [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) alongside them as a
calibration reference.

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

## The Reference Engine

PGlite and pgrust are the subjects of the comparison. wa-sqlite is not: it is the **Reference
Engine**, and its `wa-sqlite Memory` column exists so the harness itself can be checked. Both Suites
originate in wa-sqlite's benchmarks and both wa-sqlite and PGlite publish their own numbers for
them, so a wa-sqlite column that lands where those pages say it should is evidence that this
harness measures what they measure — and a column that lands somewhere else is evidence that it
does not. It is never the baseline of a ratio; like every other Configuration it is reported
against `PGlite Memory`.

It is opened the way PGlite's own benchmark page opens it — the synchronous wasm build with
`MemoryVFS` — and its timed call is `sqlite3.exec(db, sql, rowCallback)` with the rows collected,
which is the wa-sqlite equivalent of PGlite's `pg.exec(sql)`: SQL in, decoded rows out.

Two consequences of it being SQLite rather than Postgres:

- **"Unlogged" does not apply.** `CREATE UNLOGGED TABLE` is Postgres-only, so the rewrite that gives
  PGlite a second column has no wa-sqlite counterpart; the Reference Engine has exactly one column.
- **The RTT Suite's untimed setup is dialect-specific.** Its two `CREATE TABLE` statements are run
  as `INTEGER PRIMARY KEY AUTOINCREMENT` rather than `SERIAL`, byte-identical to PGlite's own SQLite
  variant. That is the only SQL that differs anywhere: every timed Benchmark in both Suites is run
  byte-identically against every Engine.

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

The RTT Suite is 100 iterations by definition, and the page offers no control that changes it. For
automation only, the URL query `?rttIterations=N` — an integer from 1 to 1000, anything else ignored —
shortens it, and says so everywhere: the environment header, the Suite itself and every Markdown
export carry `RTT iterations: N (non-standard)`, so a shortened Run cannot be mistaken for a real one.

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

| Script                  | What it does                                     |
| ----------------------- | ------------------------------------------------ |
| `bun run dev`           | Vite dev server on port 5580                     |
| `bun run build`         | Production build into `dist/`                    |
| `bun run preview`       | Serve the production build                       |
| `bun run format`        | oxfmt, check only                                |
| `bun run format:write`  | oxfmt, rewrite files                             |
| `bun run lint`          | oxlint (type-aware), check only                  |
| `bun run lint:fix`      | oxlint with autofixes applied                    |
| `bun run typecheck`     | `tsc --noEmit`                                   |
| `bun run test`          | `bun test src` — unit tests only                 |
| `bun run check`         | typecheck + lint + test                          |
| `bun run validate`      | format + check; installed as the pre-commit hook |
| `bun run bench`         | Drive the page headlessly and capture the tables |
| `bun run test:e2e`      | `bun test tests/e2e` — the bench lane, asserted  |
| `bun run validate:full` | validate + test:e2e                              |
| `bun run sync:pgrust`   | Vendor pgrust's host JS and copy its wasm assets |

`bun install` runs `prepare`, which points `core.hooksPath` at `.githooks/`, so `bun run validate`
gates every commit.

### Headless lane

`bun run bench` runs the page for you: it builds, serves `dist/` over loopback on a free port, opens
it in a real browser, presses each Suite's **Start**, waits for the Suite section to report
`data-state="complete"`, and captures exactly the Markdown the "Copy as Markdown" button produces.

The lane times nothing. Every Measurement is still taken inside the Engine's worker by the app
itself, so a headless result and a hand-run result are the same result.

```sh
bun run bench                                # both Suites, Chromium, fresh build
bun run bench --suite rtt --iterations 5     # one Suite, deliberately short RTT Run
bun run bench --browser firefox --no-build   # reuse the existing dist/
bun run bench --help                         # every flag
```

| Flag               | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `--browser <name>` | `chromium` (default), `firefox` or `webkit`                                   |
| `--suite <id>`     | `speedtest` or `rtt`; repeatable, defaults to both                            |
| `--iterations <N>` | Passes `?rttIterations=N` to the page; 1-1000                                 |
| `--no-build`       | Reuse the existing `dist/` instead of rebuilding                              |
| `--port <N>`       | Port for the local static server; the default asks for a free one, never 5580 |
| `--headed`         | Show the browser window                                                       |
| `--timeout <ms>`   | Overall in-browser deadline (default 600000)                                  |
| `--out <dir>`      | Results directory (default `tmp/results`)                                     |

Each run writes `tmp/results/<ISO-timestamp>-<browser>.md` (gitignored) and prints the same content:
the environment line, one table per Suite, and any Run failure the page reported — which is what
turns a bare `failed` cell into a diagnosis.

The browsers are Playwright's own builds, driven through its library API; there is no Playwright
config and no second test runner. Install them once with `bunx playwright install chromium firefox`.
`@playwright/test` is pinned to an exact version because a Playwright release pins the browser
revisions it will look for — floating it would silently ask for builds that are not in the cache.

| Browser in the lane           | Behaviour                                                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium (default)            | JSPI on by default, so all four Configurations run                                                                                                                                                                                                          |
| Firefox (`--browser firefox`) | The lane sets `javascript.options.wasm_js_promise_integration`; where JSPI is still missing the pgrust column reports `skipped` and the Run continues. Firefox's reduced timer precision quantises Measurements, so its numbers are coarser than Chromium's |
| WebKit (`--browser webkit`)   | Exits 0 with `WebKit skipped: Playwright's WebKit build has no JSPI yet`, without launching                                                                                                                                                                 |

`bun run test:e2e` drives the same lane from `bun test` (Chromium, both Suites, RTT at three
iterations) and asserts the shape of the result rather than any timing: an environment line, a
millisecond figure and a ratio in every PGlite and wa-sqlite cell, and `skipped`, `failed` or a
millisecond figure in every pgrust cell. The Reference Engine is held to the stricter rule on
purpose — it needs no JSPI and no asset that can be missing, so a cell without a number in it is a
harness bug rather than a browser or a build state. It is deliberately outside `test`, `check` and `validate` — `bun run
validate:full` is `validate` plus this lane.

Everything in `src/` is TypeScript with one sanctioned exception: `src/vendor/pgrust/*.js` is copied
**byte-verbatim** from a pgrust checkout by `bun run sync:pgrust` (provenance in
`src/vendor/pgrust/SOURCE.md`). Those files must never be edited, reformatted or linted here — pgrust
is upstream, and any change would silently fork the thing being benchmarked — so `src/vendor/` is in
the `ignorePatterns` of both `.oxlintrc.jsonc` and `.oxfmtrc.jsonc`. The `.d.ts` files beside them are
ours, hand-written, and are what makes the vendored JavaScript type-check under `allowJs: false`.

Adding an Engine is additive: write `src/engines/<engine>/<engine>.worker.ts` against the message
protocol in `src/engines/protocol.ts`, register its worker factory in `src/engines/registry.ts`, give
it a SQL dialect in `src/engines/contract.ts`, and add its Configuration to `src/configurations.ts`.
The dialect is read only by `Suite.initialSetupFor(dialect)`, which is what a Suite's untimed setup
comes from; no Benchmark is ever rewritten for an Engine. Whether a Configuration can run is decided at
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
- [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) itself, Copyright 2021 Roy T. Hashimoto, MIT
  licensed, is installed from npm at an exact version and used unmodified as the Reference Engine.
- They were adapted for Postgres by the [PGlite](https://github.com/electric-sql/pglite) authors
  (ElectricSQL), Apache-2.0 licensed; the SQL and statement lists here are byte-identical ports of
  PGlite's copies.
- [pgrust](https://github.com/pgxsinkit/pgrust) is AGPL-3.0 licensed. Its browser host JavaScript is
  vendored byte-verbatim under `src/vendor/pgrust/`, together with its `LICENSE` and `NOTICE`; the
  synced commit is recorded in `src/vendor/pgrust/SOURCE.md`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
