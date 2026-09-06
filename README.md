# pglite-v-pgrust

A browser benchmark that runs the same SQL workloads against [PGlite](https://pglite.dev) and
[pgrust](https://github.com/malisper/pgrust) — two WebAssembly Postgres builds — and reports the
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

wa-sqlite is installed **from its GitHub tag**, not from npm: npm only ever received `1.0.0`, while
upstream has gone on releasing by tag with `dist/` committed. The dependency is pinned to an exact
tag, `github:rhashimoto/wa-sqlite#v1.1.2`, and `bun.lock` records the commit that resolved to. The
environment header reports the tag rather than the installed manifest — `wa-sqlite v1.1.2 (github)` —
because a tagged tree's manifest can lag its tag, and `v1.1.2` still says `1.1.1` inside. Reporting
that would be reporting a version that was never released. The rule is in `src/dependency-version.ts`
and is unit-tested; a plain semver dependency still reports its manifest version as before.

One consequence of it being SQLite rather than Postgres: **the RTT Suite's untimed setup is
dialect-specific.** Its two `CREATE TABLE` statements are run as `INTEGER PRIMARY KEY AUTOINCREMENT`
rather than `SERIAL`, byte-identical to PGlite's own SQLite variant. That is the only SQL that differs
anywhere: every timed Benchmark in both Suites is run byte-identically against every Engine.

## PGlite, once

The PGlite columns and the OPFS store have to be the **same** PGlite: a benchmark that ran the Engine
on one build and the store on another would be measuring neither. PGlite here is this project's fork,
published as `@pgxsinkit/pglite`, while the store package declares its peer against the upstream name
`@electric-sql/pglite`. Rather than install both, PGlite is installed under the upstream name through
an npm alias:

```json
"@electric-sql/pglite": "npm:@pgxsinkit/pglite@0.5.5-pgx.2"
```

One dependency, one copy in `node_modules` (`bun pm ls`), one `pglite.wasm` and one `pglite.data` in
`dist/`, and the store's peer satisfied by the exact build being measured. The environment header
still names the fork — `@pgxsinkit/pglite 0.5.5-pgx.2` — and takes the version from the alias rather
than from the dependency key, which under an alias is not the installed package's name at all. That
rule lives beside wa-sqlite's git-tag rule in `src/dependency-version.ts` and is unit-tested with it.

## The columns

Eight Configurations. Six are **Memory Configurations**, two per Engine — its default settings, and
the least durable settings it offers: `PGlite Memory`, `PGlite Memory (unlogged)`, `pgrust Memory`,
`pgrust Memory (unlogged)`, `wa-sqlite Memory`, `wa-sqlite Memory (journal off)`. Two are **Storage
Configurations** on the OPFS repacked store: `PGlite OPFS repacked (relaxed)` and
`PGlite OPFS repacked (strict)`. Every ratio is against `PGlite Memory`, which is the only column
without one.

The two unlogged columns rewrite `CREATE TABLE` to `CREATE UNLOGGED TABLE` — PGlite's own benchmark
page does this, and pgrust accepts the same syntax — so the Engine writes no WAL for the Suite's
tables. In a Memory Configuration the data directory dies with the worker anyway, so the WAL buys no
durability there; unlogged only stops paying for it. The rewrite is applied on the main thread to
**every** SQL string a Run executes, the untimed setup included: the RTT Suite creates its two tables
in its setup and nowhere else, so an unlogged column whose setup was left alone would silently be a
second copy of the logged column.

`CREATE UNLOGGED TABLE` is Postgres-only, so SQLite's no-durability twin is a journal mode instead: the
`wa-sqlite Memory (journal off)` column issues `PRAGMA journal_mode = OFF` immediately after `open_v2`,
before any setup and outside every Measurement, which removes the rollback journal entirely — SQLite
then cannot roll a statement or a transaction back. The pragma is verified rather than assumed (SQLite
answers a refused journal change with the mode still in force, not with an error), and the Run fails
loudly if the read-back is not `off`. The default `wa-sqlite Memory` column keeps SQLite's own default
journal mode.

### The OPFS repacked columns

The two `PGlite OPFS repacked` columns are the first whose data directory is real storage rather than
the worker's heap. They run PGlite on
[`@pgxsinkit/pglite-opfs-repacked`](https://www.npmjs.com/package/@pgxsinkit/pglite-opfs-repacked), a
PGlite filesystem that packs a whole Postgres data directory into exactly four exclusively owned OPFS
files — an arena, two metadata logs and an activation record — instead of giving every virtual file
its own synchronous access handle the way PGlite's native OPFS filesystem does. The store's
`durability` is chosen once when it is opened and is the **only** difference between the two columns:
`relaxed` skips the per-query strict sequence and amortizes arena flushes, `strict` flushes arena data
before metadata on every awaited host sync, so a successful query has a stable boundary behind it.
Same Engine, same SQL, same store, one option.

**Neither column persists anything between Runs.** Each Run empties its store's OPFS directory before
opening it and removes the directory again when it closes, so what these columns measure is what OPFS
costs a cold data directory per statement — not what a warm one reads back. That is the same rule the
Memory Configurations get for free by dying with their worker, and it is the reason a repeated Run
gives repeatable numbers. Nothing this app writes to OPFS outlives a Run.

The store needs a `createSyncAccessHandle()` that really opens, in the dedicated worker the Engine
already runs in. That is probed at page load — a real handle on a real file, because the method's
presence proves nothing — and reported in the header:

| Browser                    | Synchronous access handle in a dedicated worker | OPFS columns     |
| -------------------------- | ----------------------------------------------- | ---------------- |
| Chromium                   | granted                                         | run              |
| Firefox                    | granted                                         | run              |
| Playwright's WebKit        | refused                                         | reported skipped |
| Safari (SharedWorker only) | refused in a dedicated worker                   | reported skipped |

Where it is refused the two columns are greyed out with that reason, the probe's own words are in the
header, and every other column runs as normal — exactly as the pgrust column behaves without JSPI.

## Results

Committed runs live in [`docs/results/`](docs/results/) — the page's own Markdown export, one file per
browser and date, produced by `bun run bench`. The current run
([2026-09-06, Chromium 152, Linux, eight columns](docs/results/2026-09-06-chromium-152-linux-eight-columns.md))
covers all eight Configurations, the two OPFS repacked columns included; the run before it
([2026-08-29, Chromium 152, Linux, six columns](docs/results/2026-08-29-chromium-152-linux-six-columns.md))
is the memory-only baseline it extends, on the same browser and the same machine.

Things the harness turned up along the way are written up in [`docs/findings/`](docs/findings/).
The first — [pgrust needs (statements × message size) memory for multi-statement
queries](docs/findings/0001-pgrust-multi-statement-memory.md) — is why the pgrust column is currently
built from a patched branch (see [pgrust assets](#pgrust-assets)).

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
Engine in a fresh worker, so no state carries over between Configurations; a Storage Configuration's
OPFS directory is emptied before its Run and removed after it, so nothing carries over between page
loads either.

The RTT Suite is 100 iterations by definition, and the page offers no control that changes it. For
automation only, the URL query `?rttIterations=N` — an integer from 1 to 1000, anything else ignored —
shortens it, and says so everywhere: the environment header, the Suite itself and every Markdown
export carry `RTT iterations: N (non-standard)`, so a shortened Run cannot be mistaken for a real one.

## pgrust assets

PGlite installs from npm; pgrust does not. Its host JavaScript is vendored into this repo and
committed; its ~87 MB of wasm build assets are not, so the `pgrust Memory` column needs one setup
step.

> **Which pgrust?** The committed results are built from the pgrust branch
> [`bench/parse-source-text-borrow`](https://github.com/pgxsinkit/pgrust/tree/bench/parse-source-text-borrow)
> (commit `dab0f929`, on top of upstream `438c8c42`), which carries the fix from
> [finding 0001](docs/findings/0001-pgrust-multi-statement-memory.md); stock pgrust cannot finish the
> Speedtest Suite on wasm32. `src/vendor/pgrust/VERSION` and the environment header always name the
> exact commit a run used.

### Download a published build

```sh
bun run sync:pgrust --release latest                     # newest published build
bun run sync:pgrust --release pgrust-assets/dab0f929     # a specific one
```

That needs no pgrust checkout and no Rust toolchain. The assets are published as **GitHub Release
assets of this repo**, one release per pgrust commit, tagged `pgrust-assets/<short-commit>` — the tag
names the exact pgrust the binaries were built from. The download is ~18 MB gzipped and unpacks to
~87 MB in `public/pgrust/`; every file is verified against the release's `SHA256SUMS` **and** against
the unpacked sizes and digests in its `manifest.json` before anything is written, and a release that
fails to verify leaves `public/pgrust/` untouched.

The release also updates `src/vendor/pgrust/VERSION` and the assets section of
`src/vendor/pgrust/SOURCE.md`, but deliberately **not** the vendored host JavaScript — releases carry
binaries, and the JS is committed here. If the two end up on different pgrust commits the sync says
so loudly rather than letting the column measure one commit's JS against another's wasm.

pgrust is AGPL-3.0. Each release names the complete corresponding source — repository, branch,
commit, upstream base and the exact build recipe — in its notes and in `manifest.json`, and
`SOURCE.md` keeps that record in the tree.

`PGLITE_V_PGRUST_RELEASE_REPO` reads the releases of a different repo;
`PGLITE_V_PGRUST_RELEASE_BASE_URL` fetches the assets from a directory URL instead of GitHub (the
release list has no meaning there, so `latest` needs a real tag).

### Building your own

Build the assets in a pgrust checkout:

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
(gitignored, ~87 MB). Run it again after every pgrust rebuild. This is also the only way to update the
vendored host JS: `--release` never touches it.

Without the assets the app still builds and the PGlite columns still run; the pgrust column reports
the fetch failure in its header.

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
| `bun run test`          | `bun test src scripts` — unit tests only         |
| `bun run check`         | typecheck + lint + test                          |
| `bun run validate`      | format + check; installed as the pre-commit hook |
| `bun run bench`         | Drive the page headlessly and capture the tables |
| `bun run test:e2e`      | `bun test tests/e2e` — the bench lane, asserted  |
| `bun run validate:full` | validate + test:e2e                              |
| `bun run sync:pgrust`   | Vendor pgrust's host JS; fetch or copy assets    |
| `bun run pgrust:bundle` | Package `public/pgrust/` for a release           |

`bun install` runs `prepare`, which points `core.hooksPath` at `.githooks/`, so `bun run validate`
gates every commit.

### Publishing pgrust assets

`bun run pgrust:bundle` turns whatever is in `public/pgrust/` into a publishable release:

```sh
bun run pgrust:bundle          # --help lists every field of the source statement
```

It reads the pgrust commit from `src/vendor/pgrust/VERSION` and `SOURCE.md` (and refuses a `-dirty`
one — a build from a working tree no one can check out has no publishable source), gzips
`postgres.wasm` and `vfs.img` at level 9, and writes `tmp/pgrust-assets/<tag with the slash
flattened>/`: the three assets, `SHA256SUMS`, `manifest.json` and `NOTES.md`. The tag is
`pgrust-assets/<first 8 of the commit>`.

The rest of the source statement — branch, upstream base, cargo profile, target, toolchain, the
`initdb` that minted `vfs.img` — cannot be read off the built files, so it comes from flags whose
defaults describe the assets currently in tree. Anything rebuilt differently must say so on the
command line; a guess in an AGPL source statement is worse than no statement.

Nothing is uploaded. The script prints the `gh release create` line — tag, title, `--notes-file
NOTES.md`, the five files — for a human to read `NOTES.md` and then run.

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
| Chromium (default)            | JSPI on by default and synchronous access handles granted in dedicated workers, so all eight Configurations run                                                                                                                                             |
| Firefox (`--browser firefox`) | The lane sets `javascript.options.wasm_js_promise_integration`; where JSPI is still missing the pgrust column reports `skipped` and the Run continues. Firefox's reduced timer precision quantises Measurements, so its numbers are coarser than Chromium's |
| WebKit (`--browser webkit`)   | Exits 0 with `WebKit skipped: Playwright's WebKit build has no JSPI yet`, without launching. That build also refuses synchronous access handles in both worker kinds, so it could contribute neither the pgrust nor the OPFS columns                        |

`bun run test:e2e` drives the same lane from `bun test` (Chromium, both Suites, RTT at three
iterations) and asserts the shape of the result rather than any timing: an environment line, a
millisecond figure and a ratio in every PGlite Memory and wa-sqlite cell, and `skipped`, `failed` or a
millisecond figure in every pgrust and OPFS cell. The Reference Engine is held to the stricter rule on
purpose — it needs no JSPI, no synchronous access handle and no asset that can be missing, so a cell
without a number in it is a harness bug rather than a browser or a build state. It is deliberately outside `test`, `check` and `validate` — `bun run
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
Engine-specific open settings go under that Engine's own key in `EngineOpenOptions` — `wasqlite` for
the journal mode, `pglite` for the store and its durability — so one Engine's knob can never reach
another's constructor. Everything this app puts in OPFS goes through `src/opfs.ts`, which keeps it
under one owned prefix and takes it away again.
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
  licensed, is used unmodified as the Reference Engine. It is installed from the exact upstream tag
  `v1.1.2` rather than from npm, whose latest publication is `1.0.0`; only its committed
  `dist/wa-sqlite.mjs` + `dist/wa-sqlite.wasm` (the synchronous build) and `src/` are used. The
  `.d.ts` in `src/engines/wasqlite/` is ours: upstream declares its API and `src/VFS.js` but no
  longer declares the example VFS modules.
- They were adapted for Postgres by the [PGlite](https://github.com/electric-sql/pglite) authors
  (ElectricSQL), Apache-2.0 licensed; the SQL and statement lists here are byte-identical ports of
  PGlite's copies.
- [`@pgxsinkit/pglite-opfs-repacked`](https://www.npmjs.com/package/@pgxsinkit/pglite-opfs-repacked),
  MIT licensed, is the OPFS store the two Storage Configurations run on, installed from npm and used
  unmodified. It declares a peer dependency on `@electric-sql/pglite`, which is why PGlite is
  installed here under that name (see [PGlite, once](#pglite-once)).
- [pgrust](https://github.com/malisper/pgrust) is AGPL-3.0 licensed. Its browser host JavaScript is
  vendored byte-verbatim under `src/vendor/pgrust/`, together with its `LICENSE` and `NOTICE`; the
  synced commit is recorded in `src/vendor/pgrust/SOURCE.md`. The wasm binaries published from this
  repo's `pgrust-assets/*` releases are built from
  [`pgxsinkit/pgrust@bench/parse-source-text-borrow`](https://github.com/pgxsinkit/pgrust/tree/bench/parse-source-text-borrow),
  and each release names its exact commit, upstream base and build recipe as the complete
  corresponding source.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
