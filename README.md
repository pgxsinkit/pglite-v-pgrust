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

The pgrust Engine is not wired up yet. When it is, `bun run sync:pgrust` will populate
`src/vendor/pgrust/` and `public/pgrust/` from a sibling `pgrust` checkout and write the synced commit
to `src/vendor/pgrust/VERSION`, which the environment header reads. Until then the script exits with
"not implemented in this slice", the `pgrust Memory` column is rendered greyed out and skipped, and
the header reports pgrust as `not synced`.

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
| `bun run sync:pgrust`  | Populate the pgrust assets (not implemented yet) |

`bun install` runs `prepare`, which points `core.hooksPath` at `.githooks/`, so `bun run validate`
gates every commit.

Adding an Engine is additive: write `src/engines/<engine>/<engine>.worker.ts` against the message
protocol in `src/engines/protocol.ts`, register its worker factory in `src/engines/registry.ts`, and
flip the Configuration's `available` flag in `src/configurations.ts`. Nothing else needs to change.

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
- [pgrust](https://github.com/pgxsinkit/pgrust) is AGPL-3.0 licensed.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
