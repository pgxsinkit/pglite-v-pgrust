import { describe, expect, test } from "bun:test";

import {
  BROKER_GATHER_LINE,
  BROKER_GATHER_PARAM,
  BROKER_SPIN_MAX_US,
  BROKER_SPIN_OFFERED_US,
  BROKER_SPIN_PARAM,
  BROKER_STATS_LINE,
  BROKER_STATS_PARAM,
  brokerGatherOptions,
  brokerSpinLine,
  brokerSpinOptions,
  describeBrokerSwitches,
  NO_BROKER_SWITCHES,
  parseBrokerSwitches,
  readBrokerSwitches,
  STORE_LEVERS,
  STORE_LEVERS_PARAM,
  storeLeverOptions,
  storeLeversLine,
  storeStatsOptions,
} from "./broker-switches";
import {
  BASELINE_CANDIDATE_IDS,
  BASELINE_CONFIGURATION_DIALECT,
  BASELINE_CONFIGURATION_ID,
  BASELINE_CONFIGURATION_LABEL,
  CONFIGURATION_IDS,
  CONFIGURATIONS,
  findConfiguration,
} from "./configurations";
import { applyModSql } from "./engines/contract";
import { isOwnedOpfsPath, OPFS_DIRECTORY_PREFIX, opfsPathSegments } from "./opfs";
import {
  describePgrustModule,
  parsePgrustModule,
  PGRUST_MODULE_PARAM,
  pgrustModuleOptions,
  readPgrustModule,
  threadsModulePath,
} from "./pgrust-module";

/** Every column whose filesystem is the broker seam, and therefore the pre-release store bundle. */
const BROKER_CONFIGURATION_IDS: readonly string[] = [
  "pgrust-threads-memory-broker",
  "pgrust-threads-opfs-repacked-relaxed",
  "pgrust-threads-opfs-repacked-strict",
  "pgrust-postmaster-memory-broker",
  "pgrust-postmaster-opfs-repacked-relaxed",
];

describe("Configurations", () => {
  test("are the fourteen Configurations, in column order", () => {
    expect(CONFIGURATIONS.map((config) => config.id)).toEqual([
      "pglite-memory",
      "pglite-memory-unlogged",
      "pglite-opfs-repacked-relaxed",
      "pglite-opfs-repacked-strict",
      "pgrust-memory",
      "pgrust-memory-unlogged",
      "pgrust-threads-memory",
      "pgrust-threads-memory-broker",
      "pgrust-threads-opfs-repacked-relaxed",
      "pgrust-threads-opfs-repacked-strict",
      "pgrust-postmaster-memory-broker",
      "pgrust-postmaster-opfs-repacked-relaxed",
      "wasqlite-memory",
      "wasqlite-memory-journal-off",
    ]);
  });

  test("label every column the way its header reads", () => {
    expect(CONFIGURATIONS.map((config) => config.label)).toEqual([
      "PGlite Memory",
      "PGlite Memory (unlogged)",
      "PGlite OPFS repacked (relaxed)",
      "PGlite OPFS repacked (strict)",
      "pgrust Memory",
      "pgrust Memory (unlogged)",
      "pgrust Threads Memory",
      "pgrust Threads Memory (broker, pre-release store)",
      "pgrust Threads OPFS repacked (relaxed, pre-release store)",
      "pgrust Threads OPFS repacked (strict, pre-release store)",
      "pgrust Postmaster Memory (broker, pre-release store)",
      "pgrust Postmaster OPFS repacked (relaxed, pre-release store)",
      "wa-sqlite Memory",
      "wa-sqlite Memory (journal off)",
    ]);
  });

  // A reader must never take a broker column for the published package: the store they load is a
  // pre-release build out of a pgxsinkit checkout, and no npm version corresponds to it.
  test("say in every broker column's own label that its store is a pre-release build", () => {
    for (const id of BROKER_CONFIGURATION_IDS) {
      expect(findConfiguration(id)?.label).toContain("pre-release store");
    }
  });

  test("put the four threads columns after the two pgrust columns and before the Reference Engine", () => {
    const ids = CONFIGURATIONS.map((config) => config.id);
    expect(ids.indexOf("pgrust-threads-memory")).toBe(ids.indexOf("pgrust-memory-unlogged") + 1);
    expect(ids.indexOf("pgrust-threads-opfs-repacked-relaxed")).toBe(ids.indexOf("pgrust-threads-memory-broker") + 1);
    expect(ids.indexOf("pgrust-threads-opfs-repacked-strict")).toBe(
      ids.indexOf("pgrust-threads-opfs-repacked-relaxed") + 1,
    );
    expect(ids.indexOf("pgrust-postmaster-memory-broker")).toBe(ids.indexOf("pgrust-threads-opfs-repacked-strict") + 1);
  });

  // The postmaster columns come after every session column and before the Reference Engine: they are
  // the same wasm module asked a different question, and a reader compares them with what is beside
  // them.
  test("put the two postmaster columns after the four threads columns and before the Reference Engine", () => {
    const ids = CONFIGURATIONS.map((config) => config.id);
    expect(ids.indexOf("pgrust-postmaster-opfs-repacked-relaxed")).toBe(
      ids.indexOf("pgrust-postmaster-memory-broker") + 1,
    );
    expect(ids.indexOf("wasqlite-memory")).toBe(ids.indexOf("pgrust-postmaster-opfs-repacked-relaxed") + 1);
  });

  // Same Engine, same store, one port apart — and no `fs` knob at all, because a postmaster whose
  // checkpointer had its own copy of the image could not see what its backends wrote.
  test("give the two postmaster columns one Engine and differ in nothing but the store's port", () => {
    const memory = findConfiguration("pgrust-postmaster-memory-broker");
    const opfs = findConfiguration("pgrust-postmaster-opfs-repacked-relaxed");
    expect(memory?.engine).toBe("pgrust-postmaster");
    expect(opfs?.engine).toBe("pgrust-postmaster");
    expect(memory?.options).toEqual({ pgrustPostmaster: { port: "memory", durability: "relaxed" } });
    expect(opfs?.options).toEqual({ pgrustPostmaster: { port: "opfs", durability: "relaxed" } });
    expect(memory?.dataDir).toBe("");
    expect(memory?.modSql).toBeUndefined();
    expect(opfs?.modSql).toBeUndefined();
  });

  test("give the two threads Memory columns one Engine and differ in nothing but the filesystem seam", () => {
    const copy = findConfiguration("pgrust-threads-memory");
    const broker = findConfiguration("pgrust-threads-memory-broker");
    expect(copy?.engine).toBe("pgrust-threads");
    expect(broker?.engine).toBe("pgrust-threads");
    expect(copy?.options).toEqual({ pgrustThreads: { fs: "copy" } });
    expect(broker?.options).toEqual({ pgrustThreads: { fs: "broker" } });
    // Both are Memory Configurations, and neither rewrites a byte of SQL.
    expect(copy?.dataDir).toBe("");
    expect(broker?.dataDir).toBe("");
    expect(copy?.modSql).toBeUndefined();
    expect(broker?.modSql).toBeUndefined();
  });

  // The same store on the same OPFS port, one option apart, exactly as PGlite's pair is.
  test("run both threads OPFS columns through the broker on one store, differing only in durability", () => {
    const relaxed = findConfiguration("pgrust-threads-opfs-repacked-relaxed");
    const strict = findConfiguration("pgrust-threads-opfs-repacked-strict");
    expect(relaxed?.engine).toBe("pgrust-threads");
    expect(strict?.engine).toBe("pgrust-threads");
    expect(relaxed?.options).toEqual({ pgrustThreads: { fs: "broker", port: "opfs", durability: "relaxed" } });
    expect(strict?.options).toEqual({ pgrustThreads: { fs: "broker", port: "opfs", durability: "strict" } });
    expect(relaxed?.modSql).toBeUndefined();
    expect(strict?.modSql).toBeUndefined();
  });

  test("give a data directory to the Storage Configurations and to nothing else", () => {
    const withDataDir = CONFIGURATIONS.filter((config) => config.dataDir !== "").map((config) => config.id);
    expect(withDataDir).toEqual([
      "pglite-opfs-repacked-relaxed",
      "pglite-opfs-repacked-strict",
      "pgrust-threads-opfs-repacked-relaxed",
      "pgrust-threads-opfs-repacked-strict",
      "pgrust-postmaster-opfs-repacked-relaxed",
    ]);
  });

  test("give each store its own OPFS directory, carrying this app's own prefix", () => {
    const directories = CONFIGURATIONS.filter((config) => config.dataDir !== "").map((config) => config.dataDir);
    // PGlite's two sit inside the prefix directory. The three pgrust ones are root-level directories
    // whose NAME carries the prefix: the vendored storage coordinator resolved its one `opfsDir`
    // against the OPFS root, which rejects a name with a slash in it. It walks a path since pgrust
    // `9bab6bff11`, but these columns keep the names their earlier Runs used (see `./opfs`).
    expect(directories).toEqual([
      `${OPFS_DIRECTORY_PREFIX}/opfs-repacked-relaxed`,
      `${OPFS_DIRECTORY_PREFIX}/opfs-repacked-strict`,
      `${OPFS_DIRECTORY_PREFIX}-threads-opfs-repacked-relaxed`,
      `${OPFS_DIRECTORY_PREFIX}-threads-opfs-repacked-strict`,
      `${OPFS_DIRECTORY_PREFIX}-postmaster-opfs-repacked-relaxed`,
    ]);
    // Two live owners of one directory is a StoreOwnedError; two columns sharing one would also be
    // one column measuring the other's data directory.
    expect(new Set(directories).size).toBe(directories.length);
    for (const directory of directories) {
      expect(isOwnedOpfsPath(directory)).toBe(true);
      expect(opfsPathSegments(directory)[0]).toStartWith(OPFS_DIRECTORY_PREFIX);
    }
  });

  test("run both OPFS columns on the same Engine and store, differing only in durability", () => {
    const relaxed = findConfiguration("pglite-opfs-repacked-relaxed");
    const strict = findConfiguration("pglite-opfs-repacked-strict");
    expect(relaxed?.engine).toBe("pglite");
    expect(strict?.engine).toBe("pglite");
    expect(relaxed?.options).toEqual({ pglite: { store: "opfs-repacked", durability: "relaxed" } });
    expect(strict?.options).toEqual({ pglite: { store: "opfs-repacked", durability: "strict" } });
    // No SQL rewrite: the two columns must be the same workload on the same store.
    expect(relaxed?.modSql).toBeUndefined();
    expect(strict?.modSql).toBeUndefined();
  });

  test("take their ratios against PGlite Memory", () => {
    expect(BASELINE_CONFIGURATION_ID).toBe("pglite-memory");
    expect(BASELINE_CONFIGURATION_LABEL).toBe("PGlite Memory");
    expect(BASELINE_CONFIGURATION_DIALECT).toBe("postgres");
    expect(findConfiguration(BASELINE_CONFIGURATION_ID)?.engine).toBe("pglite");
  });

  test("give both pgrust columns their own Engine", () => {
    expect(findConfiguration("pgrust-memory")?.engine).toBe("pgrust");
    expect(findConfiguration("pgrust-memory-unlogged")?.engine).toBe("pgrust");
  });

  test("offer every column but the Reference Engine's as a Baseline, in column order", () => {
    expect(CONFIGURATION_IDS).toEqual(CONFIGURATIONS.map((config) => config.id));
    expect(BASELINE_CANDIDATE_IDS).toEqual(CONFIGURATION_IDS.filter((id) => !id.startsWith("wasqlite-")));
  });

  test("give the Reference Engine its own two columns, and never the Baseline", () => {
    const reference = findConfiguration("wasqlite-memory");
    expect(reference?.engine).toBe("wasqlite");
    expect(reference?.id).not.toBe(BASELINE_CONFIGURATION_ID);
    expect(CONFIGURATIONS.filter((config) => config.engine === "wasqlite").map((config) => config.id)).toEqual([
      "wasqlite-memory",
      "wasqlite-memory-journal-off",
    ]);
  });

  test("leave the unlogged rewrite to the Postgres builds: SQLite has no unlogged tables", () => {
    expect(findConfiguration("wasqlite-memory")?.modSql).toBeUndefined();
    expect(findConfiguration("wasqlite-memory-journal-off")?.modSql).toBeUndefined();
    expect(findConfiguration("pglite-memory")?.modSql).toBeUndefined();
    expect(findConfiguration("pgrust-memory")?.modSql).toBeUndefined();
  });

  test("give SQLite its no-durability twin as a journal mode rather than a SQL rewrite", () => {
    const journalOff = findConfiguration("wasqlite-memory-journal-off");
    expect(journalOff?.engine).toBe("wasqlite");
    expect(journalOff?.options).toEqual({ wasqlite: { journalMode: "off" } });
    // The default wa-sqlite column keeps SQLite's own default journal mode: no options at all.
    expect(findConfiguration("wasqlite-memory")?.options).toBeUndefined();
  });

  test("leave the open options to the Configurations that have them", () => {
    for (const id of ["pglite-memory", "pglite-memory-unlogged", "pgrust-memory", "pgrust-memory-unlogged"]) {
      expect(findConfiguration(id)?.options).toBeUndefined();
    }
  });

  test("rewrite CREATE TABLE for both unlogged Configurations exactly as PGlite does", () => {
    for (const id of ["pglite-memory-unlogged", "pgrust-memory-unlogged"]) {
      const unlogged = findConfiguration(id);
      expect(unlogged).toBeDefined();
      if (unlogged === undefined) {
        continue;
      }
      expect(applyModSql(unlogged, "CREATE TABLE a (x int); CREATE TABLE b (y int);")).toBe(
        "CREATE UNLOGGED TABLE a (x int); CREATE UNLOGGED TABLE b (y int);",
      );
      expect(applyModSql(unlogged, "SELECT 1;")).toBe("SELECT 1;");
    }
  });

  test("leave SQL untouched for Configurations without a rewrite", () => {
    const baseline = findConfiguration(BASELINE_CONFIGURATION_ID);
    expect(baseline).toBeDefined();
    if (baseline === undefined) {
      return;
    }
    expect(applyModSql(baseline, "CREATE TABLE a (x int);")).toBe("CREATE TABLE a (x int);");
  });
});

// `?pgrustModule=<id>` swaps the threads module of the six threads and postmaster columns for an
// alternate the build carries; everything else about those columns stays as it is.
describe("the alternate pgrust threads module", () => {
  const available = ["3624f82c"];

  test("is accepted only when the build carries it, and ignored otherwise", () => {
    expect(parsePgrustModule(`?${PGRUST_MODULE_PARAM}=3624f82c`, available)).toBe("3624f82c");
    expect(parsePgrustModule(`?${PGRUST_MODULE_PARAM}= 3624F82C `, available)).toBe("3624f82c");
    expect(parsePgrustModule("", available)).toBeNull();
    for (const value of ["", "e2e7a2f9", "3624f82", "3624f82c/../..", "latest", "not-hex!"]) {
      expect(parsePgrustModule(`?${PGRUST_MODULE_PARAM}=${encodeURIComponent(value)}`, available)).toBeNull();
    }
    expect(parsePgrustModule(`?${PGRUST_MODULE_PARAM}=3624f82c`, [])).toBeNull();
  });

  test("is read as absent where there is no page URL, so every default Configuration is unchanged", () => {
    expect(readPgrustModule()).toBeNull();
    for (const config of CONFIGURATIONS) {
      expect(config.options?.pgrustThreads?.alternateModule).toBeUndefined();
      expect(config.options?.pgrustPostmaster?.alternateModule).toBeUndefined();
    }
  });

  test("is loaded from alt/<id>/, and the build's own module otherwise", () => {
    expect(threadsModulePath(null)).toBe("postgres-threads.wasm");
    expect(threadsModulePath(undefined)).toBe("postgres-threads.wasm");
    expect(threadsModulePath("3624f82c")).toBe("alt/3624f82c/postgres-threads.wasm");
    expect(() => threadsModulePath("../3624f82c")).toThrow("not a pgrust module id");
  });

  test("adds nothing to the open options unless one is in effect, and names itself as an alternate", () => {
    expect(pgrustModuleOptions(null)).toEqual({});
    expect(Object.keys(pgrustModuleOptions(null))).toEqual([]);
    expect(pgrustModuleOptions("3624f82c")).toEqual({ alternateModule: "3624f82c" });
    expect(describePgrustModule("3624f82c")).toBe("pgrust module: 3624f82c (alternate)");
  });
});

// `?brokerStats=1` counts every Measurement's store work, `?brokerGather=1` turns on the pgrust
// broker's gathered writes, `?brokerSpin=` its spin before parking and `?storeLevers=` the pgrust
// coordinator's store levers; none may change a Configuration's options when it is off.
describe("the store-seam switches", () => {
  test("turn on for exactly `1`, and are ignored for anything else", () => {
    expect(parseBrokerSwitches(`?${BROKER_STATS_PARAM}=1`)).toEqual({ ...NO_BROKER_SWITCHES, stats: true });
    expect(parseBrokerSwitches(`?${BROKER_GATHER_PARAM}=1`)).toEqual({ ...NO_BROKER_SWITCHES, gather: true });
    expect(parseBrokerSwitches(`?${BROKER_STATS_PARAM}=1&${BROKER_GATHER_PARAM}=1`)).toEqual({
      ...NO_BROKER_SWITCHES,
      stats: true,
      gather: true,
    });
    expect(parseBrokerSwitches(`?${BROKER_STATS_PARAM}=%201%20`)).toEqual({ ...NO_BROKER_SWITCHES, stats: true });
    for (const value of ["", "0", "true", "on", "yes", "2"]) {
      expect(parseBrokerSwitches(`?${BROKER_STATS_PARAM}=${value}&${BROKER_GATHER_PARAM}=${value}`)).toEqual(
        NO_BROKER_SWITCHES,
      );
    }
    expect(parseBrokerSwitches("")).toEqual(NO_BROKER_SWITCHES);
  });

  test("take a spin of 0 to the maximum µs, the offered ones included, and ignore anything else", () => {
    for (const spinUs of [...BROKER_SPIN_OFFERED_US, 1, 999, BROKER_SPIN_MAX_US]) {
      expect(parseBrokerSwitches(`?${BROKER_SPIN_PARAM}=${spinUs}`)).toEqual({ ...NO_BROKER_SWITCHES, spinUs });
    }
    expect(BROKER_SPIN_OFFERED_US).toEqual([0, 50, 200]);
    expect(parseBrokerSwitches(`?${BROKER_SPIN_PARAM}=%20200%20`).spinUs).toBe(200);
    for (const value of ["", "-1", "1001", "50.5", "5e1", "0x10", "fast", "200us", "99999"]) {
      expect(parseBrokerSwitches(`?${BROKER_SPIN_PARAM}=${value}`)).toEqual(NO_BROKER_SWITCHES);
    }
  });

  test("take the two store levers by name, in canonical order, and drop any other name", () => {
    expect(parseBrokerSwitches(`?${STORE_LEVERS_PARAM}=grow,coalesce`).storeLevers).toEqual(["grow", "coalesce"]);
    expect(parseBrokerSwitches(`?${STORE_LEVERS_PARAM}=coalesce,%20grow,grow`).storeLevers).toEqual([
      "grow",
      "coalesce",
    ]);
    expect(parseBrokerSwitches(`?${STORE_LEVERS_PARAM}=coalesce`).storeLevers).toEqual(["coalesce"]);
    // U3 and U4 of the store-levers note are deliberately not offered.
    expect(parseBrokerSwitches(`?${STORE_LEVERS_PARAM}=grow,zeroskip,metacoalesce`).storeLevers).toEqual(["grow"]);
    for (const value of ["", "1", "zeroskip", "metacoalesce", "GROW", "grow;coalesce"]) {
      expect(parseBrokerSwitches(`?${STORE_LEVERS_PARAM}=${value}`)).toEqual(NO_BROKER_SWITCHES);
    }
  });

  test("name the same spin bound and the same levers as the pgrust host they are handed to", async () => {
    const spin = await import("./vendor/pgrust/broker-spin.js");
    const levers = await import("./vendor/pgrust/store-levers.js");
    expect(BROKER_SPIN_MAX_US).toBe(spin.MAX_BROKER_SPIN_US);
    expect<readonly string[]>(STORE_LEVERS).toEqual(levers.STORE_LEVER_NAMES);
    expect(spin.normalizeSpinUs(BROKER_SPIN_MAX_US)).toBe(BROKER_SPIN_MAX_US);
    expect(() => spin.normalizeSpinUs(BROKER_SPIN_MAX_US + 1)).toThrow(RangeError);
    expect(() => levers.normalizeStoreLevers(["zeroskip"])).toThrow(RangeError);
  });

  test("announce themselves in a fixed order, and say nothing when off", () => {
    expect(describeBrokerSwitches(NO_BROKER_SWITCHES)).toEqual([]);
    expect(
      describeBrokerSwitches({ stats: true, gather: true, spinUs: 200, storeLevers: ["grow", "coalesce"] }),
    ).toEqual([
      BROKER_STATS_LINE,
      BROKER_GATHER_LINE,
      "broker spin: 200 µs",
      "store levers: grow, coalesce (pgrust columns only)",
    ]);
    expect(BROKER_STATS_LINE).toBe("broker stats: on");
    expect(BROKER_GATHER_LINE).toBe("broker gather: on");
    expect(brokerSpinLine(50)).toBe("broker spin: 50 µs");
    expect(storeLeversLine(["coalesce"])).toBe("store levers: coalesce (pgrust columns only)");
    // A 0-µs spin changes nothing and is still announced, so the control Run of an A/B carries its label.
    expect(describeBrokerSwitches({ ...NO_BROKER_SWITCHES, spinUs: 0 })).toEqual(["broker spin: 0 µs"]);
  });

  test("add nothing to the open options unless they are on", () => {
    expect(Object.keys(storeStatsOptions(NO_BROKER_SWITCHES))).toEqual([]);
    expect(Object.keys(brokerGatherOptions(NO_BROKER_SWITCHES))).toEqual([]);
    expect(Object.keys(brokerSpinOptions(NO_BROKER_SWITCHES))).toEqual([]);
    expect(Object.keys(brokerSpinOptions({ ...NO_BROKER_SWITCHES, spinUs: 0 }))).toEqual([]);
    expect(Object.keys(storeLeverOptions(NO_BROKER_SWITCHES))).toEqual([]);
    expect(storeStatsOptions({ ...NO_BROKER_SWITCHES, stats: true })).toEqual({ storeStats: true });
    expect(brokerGatherOptions({ ...NO_BROKER_SWITCHES, gather: true })).toEqual({ brokerGather: true });
    expect(brokerSpinOptions({ ...NO_BROKER_SWITCHES, spinUs: 50 })).toEqual({ brokerSpinUs: 50 });
    expect(storeLeverOptions({ ...NO_BROKER_SWITCHES, storeLevers: ["grow"] })).toEqual({ storeLevers: ["grow"] });
  });

  test("are read as off where there is no page URL, so every default Configuration is unchanged", () => {
    expect(readBrokerSwitches()).toEqual(NO_BROKER_SWITCHES);
    for (const config of CONFIGURATIONS) {
      expect(config.options?.storeStats).toBeUndefined();
      expect(config.options?.pgrustThreads?.brokerGather).toBeUndefined();
      expect(config.options?.pgrustPostmaster?.brokerGather).toBeUndefined();
      expect(config.options?.pgrustThreads?.brokerSpinUs).toBeUndefined();
      expect(config.options?.pgrustPostmaster?.brokerSpinUs).toBeUndefined();
      expect(config.options?.pgrustThreads?.storeLevers).toBeUndefined();
      expect(config.options?.pgrustPostmaster?.storeLevers).toBeUndefined();
    }
    // The two single-session pgrust columns and every Memory column that has nothing to count carry
    // no options at all, exactly as before the switch existed.
    for (const id of ["pglite-memory", "pglite-memory-unlogged", "pgrust-memory", "pgrust-memory-unlogged"]) {
      expect(findConfiguration(id)?.options).toBeUndefined();
    }
  });

  test("gather only on the broker columns: the copy seam has no broker to gather for", () => {
    for (const id of BROKER_CONFIGURATION_IDS) {
      const config = findConfiguration(id);
      expect(config?.options?.pgrustThreads?.fs ?? "broker").toBe("broker");
    }
    expect(findConfiguration("pgrust-threads-memory")?.options?.pgrustThreads?.fs).toBe("copy");
  });

  // The Configurations read the URL once, when their module loads; a second copy of the module,
  // loaded under a page URL, is how the spread itself is seen.
  test("reach the pgrust broker columns alone: never PGlite's OPFS pair, never the copy seam", async () => {
    const scope = globalThis as { location?: { search: string } };
    scope.location = {
      search: `?${BROKER_GATHER_PARAM}=1&${BROKER_SPIN_PARAM}=200&${STORE_LEVERS_PARAM}=grow,coalesce`,
    };
    // A query string makes it a second module instance; a variable keeps tsc from resolving it as a path.
    const specifier = "./configurations.ts?switched";
    let switched: typeof CONFIGURATIONS;
    try {
      switched = ((await import(specifier)) as { readonly CONFIGURATIONS: typeof CONFIGURATIONS }).CONFIGURATIONS;
    } finally {
      delete scope.location;
    }
    const levers = { brokerGather: true, brokerSpinUs: 200, storeLevers: ["grow", "coalesce"] };
    for (const config of switched) {
      const pgrust = config.options?.pgrustThreads ?? config.options?.pgrustPostmaster;
      if (BROKER_CONFIGURATION_IDS.includes(config.id)) {
        expect(pgrust).toMatchObject(levers);
      } else {
        expect(pgrust?.brokerGather).toBeUndefined();
        expect(pgrust?.brokerSpinUs).toBeUndefined();
        expect(pgrust?.storeLevers).toBeUndefined();
        expect(JSON.stringify(config.options ?? {})).toBe(JSON.stringify(findConfiguration(config.id)?.options ?? {}));
      }
    }
    expect(switched.filter((config) => BROKER_CONFIGURATION_IDS.includes(config.id))).toHaveLength(5);
  });
});
