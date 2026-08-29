import { describe, expect, test } from "bun:test";

import { describeDependencyVersion } from "./dependency-version";

describe("describeDependencyVersion", () => {
  test("reports a GitHub dependency's pinned tag, labelled as such", () => {
    expect(describeDependencyVersion("github:rhashimoto/wa-sqlite#v1.1.2", "1.1.1")).toBe("v1.1.2 (github)");
  });

  test("prefers the tag over the manifest, which at v1.1.2 still says 1.1.1", () => {
    expect(describeDependencyVersion("github:rhashimoto/wa-sqlite#v1.1.2", "1.1.1")).not.toContain("1.1.1");
  });

  test("labels other git hosts without claiming they are GitHub", () => {
    expect(describeDependencyVersion("gitlab:owner/repo#v2.0.0", "0.0.0")).toBe("v2.0.0 (git)");
    expect(describeDependencyVersion("git+https://example.com/repo.git#abc1234", "0.0.0")).toBe("abc1234 (git)");
  });

  test("takes the last # so a ref containing one cannot truncate the version", () => {
    expect(describeDependencyVersion("github:owner/repo#feature#v3", "0.0.0")).toBe("v3 (github)");
  });

  test("falls back to the manifest for a plain semver specifier", () => {
    expect(describeDependencyVersion("^19.2.8", "19.2.9")).toBe("19.2.9");
    expect(describeDependencyVersion("0.5.5-pgx.2", "0.5.5-pgx.2")).toBe("0.5.5-pgx.2");
  });

  test("falls back to the manifest for an absent specifier or a ref-less git specifier", () => {
    expect(describeDependencyVersion(undefined, "1.2.3")).toBe("1.2.3");
    expect(describeDependencyVersion("github:owner/repo", "1.2.3")).toBe("1.2.3");
    expect(describeDependencyVersion("github:owner/repo#", "1.2.3")).toBe("1.2.3");
    expect(describeDependencyVersion("github:owner/repo#   ", "1.2.3")).toBe("1.2.3");
  });
});
