import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EngineId } from "../../engines/contract";
import { SPEEDTEST_BENCHMARK_LABELS, speedtestSqlFileName } from "../speedtest/benchmarks";
import { benchmarkSql, isScenarioBenchmark, suiteUnsupportedReason } from "../types";
import type { PreparedBenchmarkId } from "./benchmarks";
import {
  deallocateText,
  PREPARED_BENCHMARK_IDS,
  PREPARED_BENCHMARK_LABELS,
  PREPARED_SHAPES,
  PREPARED_SQLITE_NOTE,
  PREPARED_SQLITE_REASON,
  prepareText,
  preparedSetupTexts,
  preparedSqlFileName,
  preparedTeardownTexts,
} from "./benchmarks";
import { buildPreparedSuite } from "./suite";

/** A row's timed text as the bundle imports it, read from disk because `?raw` is a bundler feature. */
function preparedSql(id: PreparedBenchmarkId): string {
  return readFileSync(join(import.meta.dir, preparedSqlFileName(id)), "utf8");
}

/** A Speedtest script, byte for byte. */
function speedtestSql(id: string): string {
  return readFileSync(join(import.meta.dir, "../speedtest", speedtestSqlFileName(id as never)), "utf8");
}

const SQL_FROM_DISK = Object.fromEntries(PREPARED_BENCHMARK_IDS.map((id) => [id, preparedSql(id)])) as Record<
  PreparedBenchmarkId,
  string
>;

const SUITE = buildPreparedSuite(SQL_FROM_DISK);

/** How many statements each Speedtest script runs in its loop. */
const LOOP_STATEMENTS: Readonly<Record<PreparedBenchmarkId, number>> = {
  "1": 1000,
  "2": 25000,
  "3": 25000,
  "7": 5000,
  "8": 1000,
  "9": 25000,
  "10": 25000,
};

/** One `EXECUTE name(a, b, …);` line, split into its name and its SQL literals. */
function parseExecute(line: string): { readonly name: string; readonly args: readonly string[] } {
  const match = /^EXECUTE (\w+)\((.*)\);$/.exec(line);
  if (match === null) {
    throw new Error(`not an EXECUTE: ${line}`);
  }
  const args: string[] = [];
  const literal = /(-?\d+|'(?:[^']|'')*')(?:, |$)/y;
  const list = match[2] ?? "";
  while (literal.lastIndex < list.length) {
    const found = literal.exec(list);
    if (found === null) {
      throw new Error(`unparseable arguments: ${list}`);
    }
    args.push(found[1] ?? "");
  }
  return { name: match[1] ?? "", args };
}

/**
 * The Speedtest's script, rebuilt from the Prepared row: every `EXECUTE` turned back into the
 * statement it stands for, and the DDL the row moved to its untimed setup put back where the
 * Speedtest's script had it (row 7's is row 6's script, so it is not part of row 7's text).
 */
function rebuildSpeedtest(id: PreparedBenchmarkId): string {
  const shape = PREPARED_SHAPES[id];
  const lines = preparedSql(id).slice(0, -1).split("\n");
  const rebuilt: string[] = [];
  const ddl = id === "7" || shape.state === null ? [] : shape.state.slice(0, -1).split("\n");
  for (const line of lines) {
    if (line === "BEGIN;") {
      rebuilt.push(line, ...ddl);
      continue;
    }
    if (line === "COMMIT;") {
      rebuilt.push(line);
      continue;
    }
    const { name, args } = parseExecute(line);
    expect(name).toBe(shape.name);
    rebuilt.push(`${shape.statement.replace(/\$(\d+)/g, (_, n: string) => args[Number(n) - 1] ?? "?")};`);
  }
  const opensTransaction = lines[0] === "BEGIN;";
  return `${[...(opensTransaction ? [] : ddl), ...rebuilt].join("\n")}\n`;
}

describe("Prepared Suite definition", () => {
  test("prepares the Speedtest's seven statement-heavy rows, in the Speedtest's order", () => {
    expect([...PREPARED_BENCHMARK_IDS]).toEqual(["1", "2", "3", "7", "8", "9", "10"]);
    expect(SUITE.id).toBe("prepared");
    expect(SUITE.title).toBe("Prepared Suite");
    expect(SUITE.benchmarks.map((benchmark) => benchmark.id)).toEqual([...PREPARED_BENCHMARK_IDS]);
    expect(SUITE.iterations).toBe(1);
    expect(SUITE.aggregation).toBe("mean");
    expect(SUITE.editableSetup).toBe(false);
  });

  // Every total this repo's notes take from a pasted table is a sum over its `| Test` rows.
  test("labels every row with the Speedtest's label and `(prepared)`, so it is still a `Test` row", () => {
    for (const id of PREPARED_BENCHMARK_IDS) {
      expect(PREPARED_BENCHMARK_LABELS[id]).toBe(`${SPEEDTEST_BENCHMARK_LABELS[id]} (prepared)`);
      expect(PREPARED_BENCHMARK_LABELS[id]).toStartWith(`Test ${id}: `);
    }
    expect(PREPARED_BENCHMARK_LABELS["9"]).toBe("Test 9: 25000 UPDATEs with an index (prepared)");
    expect(SUITE.benchmarks.map((benchmark) => benchmark.label)).toEqual(
      PREPARED_BENCHMARK_IDS.map((id) => PREPARED_BENCHMARK_LABELS[id]),
    );
  });

  test("ships one timed text per row", () => {
    for (const id of PREPARED_BENCHMARK_IDS) {
      expect(existsSync(join(import.meta.dir, preparedSqlFileName(id)))).toBe(true);
    }
  });

  test("builds nothing before the rows: every row builds what it needs in its own setup", () => {
    expect(SUITE.initialSetupFor("postgres")).toBe("");
  });

  test("is a Suite of statements, each with its own untimed setup and teardown", () => {
    for (const benchmark of SUITE.benchmarks) {
      if (isScenarioBenchmark(benchmark)) {
        throw new Error(`row ${benchmark.id} is a Scenario`);
      }
      const id = benchmark.id as PreparedBenchmarkId;
      expect(benchmark.sql).toBe(preparedSql(id));
      expect(benchmark.setup).toEqual(preparedSetupTexts(id));
      expect(benchmark.teardown).toEqual(preparedTeardownTexts(id));
    }
  });
});

describe("Prepared Suite, the rows' SQL", () => {
  for (const id of PREPARED_BENCHMARK_IDS) {
    test(`row ${id}: every EXECUTE turns back into the Speedtest's statement, byte for byte`, () => {
      expect(rebuildSpeedtest(id)).toBe(speedtestSql(id));
    });

    test(`row ${id}: runs the Speedtest's statement count, each as an EXECUTE of its shape`, () => {
      const lines = preparedSql(id).slice(0, -1).split("\n");
      const executes = lines.filter((line) => line.startsWith("EXECUTE "));
      expect(executes).toHaveLength(LOOP_STATEMENTS[id]);
      expect(executes.every((line) => line.startsWith(`EXECUTE ${PREPARED_SHAPES[id].name}(`))).toBe(true);
      // Nothing but the EXECUTEs and the Speedtest's own transaction: no PREPARE in the timed text.
      expect(lines.filter((line) => !line.startsWith("EXECUTE "))).toEqual(id === "1" ? [] : ["BEGIN;", "COMMIT;"]);
      expect(preparedSql(id)).not.toContain("PREPARE");
      expect(preparedSql(id)).not.toContain("CREATE");
    });
  }

  test("prepares each shape with one parameter type per placeholder, in its own short text", () => {
    for (const id of PREPARED_BENCHMARK_IDS) {
      const shape = PREPARED_SHAPES[id];
      const placeholders = new Set(shape.statement.match(/\$\d+/g));
      expect(placeholders.size).toBe(shape.parameterTypes.length);
      const text = prepareText(shape);
      expect(text).toBe(`PREPARE ${shape.name}(${shape.parameterTypes.join(", ")}) AS ${shape.statement};\n`);
      // Its own text, and a short one: a PREPARE's source text is its whole message, and every
      // EXECUTE copies it into its portal.
      expect(text.length).toBeLessThan(100);
    }
    expect(prepareText(PREPARED_SHAPES["9"])).toBe("PREPARE p9(integer, integer) AS UPDATE t2 SET b=$1 WHERE a=$2;\n");
  });

  test("builds each row's tables first, then prepares, then deallocates after the row", () => {
    expect(preparedSetupTexts("1")).toEqual([
      "CREATE TABLE t1(a INTEGER, b INTEGER, c VARCHAR(100));\n",
      "PREPARE p1(integer, integer, varchar) AS INSERT INTO t1 VALUES($1, $2, $3);\n",
    ]);
    expect(preparedSetupTexts("3")[0]).toBe(
      "CREATE TABLE t3(a INTEGER, b INTEGER, c VARCHAR(100));\nCREATE INDEX i3 ON t3(c);\n",
    );
    expect(preparedSetupTexts("9")).toEqual([prepareText(PREPARED_SHAPES["9"])]);
    for (const id of PREPARED_BENCHMARK_IDS) {
      expect(preparedTeardownTexts(id)).toEqual([deallocateText(PREPARED_SHAPES[id])]);
    }
    expect(deallocateText(PREPARED_SHAPES["10"])).toBe("DEALLOCATE p10;\n");
  });

  // Row 7 plans against the indexes the Speedtest's row 6 built, after row 2's rows were in.
  test("builds row 6's two indexes before row 7, with row 6's own script", () => {
    expect(PREPARED_SHAPES["7"].state).toBe(speedtestSql("6"));
  });

  test("names its statements uniquely, so a missed DEALLOCATE could not be mistaken for another row's", () => {
    const names = PREPARED_BENCHMARK_IDS.map((id) => PREPARED_SHAPES[id].name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("Prepared Suite, the Engines it runs on", () => {
  const ENGINES: readonly EngineId[] = ["pglite", "pgrust", "pgrust-threads", "pgrust-postmaster", "wasqlite"];

  test("runs on every Postgres Engine and refuses SQLite, saying why", () => {
    expect(suiteUnsupportedReason(SUITE, "postgres")).toBeUndefined();
    expect(suiteUnsupportedReason(SUITE, "sqlite")).toBe(PREPARED_SQLITE_REASON);
  });

  test("says so in the wa-sqlite columns' headers, and nowhere else", () => {
    for (const engine of ENGINES) {
      expect(SUITE.columnNoteFor?.(engine)).toBe(engine === "wasqlite" ? PREPARED_SQLITE_NOTE : undefined);
    }
  });

  test("hands every Postgres Engine the same bytes", () => {
    expect("benchmarksFor" in SUITE).toBe(false);
    expect(SUITE.benchmarks.map(benchmarkSql)).toEqual(PREPARED_BENCHMARK_IDS.map((id) => preparedSql(id)));
  });
});
