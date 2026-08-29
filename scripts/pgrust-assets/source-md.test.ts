import { describe, expect, test } from "bun:test";

import type { AssetManifest } from "./manifest";
import { buildManifest } from "./manifest";
import {
  ASSETS_BEGIN,
  ASSETS_END,
  checkoutAssetsSection,
  extractAssetsSection,
  readVendorCommit,
  releaseAssetsSection,
  replaceAssetsSection,
  vendorMismatchWarning,
} from "./source-md";

const COMMIT = "dab0f92940dcf893d981f766f34baf776b59ed33";

/** The vendored half of SOURCE.md as `sync:pgrust` writes it from a checkout. */
const VENDOR_HALF = [
  "# Vendored from pgrust",
  "",
  `- Commit: \`${COMMIT}\``,
  "- Version: `dab0f92940`",
  "",
  "pgrust is AGPL-3.0-only; its `LICENSE` and `NOTICE` are vendored alongside the source.",
  "",
].join("\n");

function manifest(commit = COMMIT): AssetManifest {
  return buildManifest({
    tag: "pgrust-assets/dab0f929",
    commit,
    shortCommit: commit.slice(0, 10),
    branch: "bench/parse-source-text-borrow",
    upstreamCommit: "438c8c420b96b23ca61927ba57e608839f86e935",
    profile: "wasm-release",
    target: "wasm32-wasip1",
    toolchain: "nightly-2026-07-17",
    initdb: "PostgreSQL 18",
    builtAt: "2026-08-29T11:19:00.000Z",
    files: [{ name: "vfs.json", bytes: 20, sha256: "c".repeat(64) }],
  });
}

describe("readVendorCommit", () => {
  test("reads the commit of the vendored host JS", () => {
    expect(readVendorCommit(VENDOR_HALF)).toBe(COMMIT);
  });

  test("ignores commits inside the assets block, which describe the binary instead", () => {
    const withAssets = replaceAssetsSection(VENDOR_HALF, `- Commit: \`${"f".repeat(40)}\``);
    expect(readVendorCommit(withAssets)).toBe(COMMIT);
    expect(readVendorCommit(replaceAssetsSection("# Vendored\n", `- Commit: \`${"f".repeat(40)}\``))).toBeNull();
  });

  test("returns null when no commit is recorded", () => {
    expect(readVendorCommit("# Vendored from pgrust\n")).toBeNull();
  });
});

describe("replaceAssetsSection", () => {
  test("appends a fenced block and leaves the vendored half byte-identical", () => {
    const written = replaceAssetsSection(VENDOR_HALF, "## Binary assets\n\n- Release: `x`");
    expect(written.startsWith(VENDOR_HALF.replace(/\n+$/, ""))).toBe(true);
    expect(written).toContain(`${ASSETS_BEGIN}\n## Binary assets\n\n- Release: \`x\`\n${ASSETS_END}\n`);
    expect(written.endsWith("\n")).toBe(true);
  });

  test("replaces an existing block rather than stacking a second one", () => {
    const once = replaceAssetsSection(VENDOR_HALF, "first");
    const twice = replaceAssetsSection(once, "second");
    expect(twice.split(ASSETS_BEGIN)).toHaveLength(2);
    expect(extractAssetsSection(twice)).toBe("second");
  });

  test("removes the block when given null, so a vendor-only sync can drop it", () => {
    const once = replaceAssetsSection(VENDOR_HALF, "first");
    expect(replaceAssetsSection(once, null)).toBe(VENDOR_HALF);
    expect(extractAssetsSection(replaceAssetsSection(once, null))).toBeNull();
  });

  test("round-trips a multi-line section", () => {
    const section = releaseAssetsSection(manifest(), "https://example.test/tag", "2026-08-29T12:00:00.000Z", null);
    expect(extractAssetsSection(replaceAssetsSection(VENDOR_HALF, section))).toBe(section);
  });
});

describe("releaseAssetsSection", () => {
  test("keeps the canonical release link but says when the bytes came from an override", () => {
    const canonical = releaseAssetsSection(manifest(), "https://example.test/tag", "2026-08-29T12:00:00.000Z", null);
    expect(canonical).not.toContain("PGLITE_V_PGRUST_RELEASE_BASE_URL");
    const overridden = releaseAssetsSection(
      manifest(),
      "https://example.test/tag",
      "2026-08-29T12:00:00.000Z",
      "http://127.0.0.1:8791",
    );
    expect(overridden).toContain("https://example.test/tag");
    expect(overridden).toContain("- Fetched from: `http://127.0.0.1:8791` (PGLITE_V_PGRUST_RELEASE_BASE_URL)");
  });

  test("names the release, the AGPL source and the build recipe", () => {
    const section = releaseAssetsSection(manifest(), "https://example.test/tag", "2026-08-29T12:00:00.000Z", null);
    expect(section).toContain("pgrust-assets/dab0f929");
    expect(section).toContain("https://github.com/pgxsinkit/pgrust/tree/bench/parse-source-text-borrow");
    expect(section).toContain(`https://github.com/pgxsinkit/pgrust/commit/${COMMIT}`);
    expect(section).toContain("`wasm-release` / `wasm32-wasip1` / `nightly-2026-07-17`");
    expect(section).toContain("AGPL-3.0-only");
  });
});

describe("checkoutAssetsSection", () => {
  test("says the binaries were built locally, and from where", () => {
    const section = checkoutAssetsSection("/home/dev/pgrust", "dab0f92940", "2026-08-29T12:00:00.000Z");
    expect(section).toContain("/home/dev/pgrust");
    expect(section).toContain("`dab0f92940`");
    expect(section).toContain("local pgrust checkout");
  });
});

describe("vendorMismatchWarning", () => {
  test("says nothing when the host JS and the binary are the same commit", () => {
    expect(vendorMismatchWarning(COMMIT, manifest())).toEqual([]);
  });

  test("treats an abbreviated record as a match when it is a prefix", () => {
    expect(vendorMismatchWarning("dab0f92940", manifest())).toEqual([]);
  });

  test("warns in full when they are different commits, and says how to fix it", () => {
    const other = "0".repeat(39) + "1";
    const warning = vendorMismatchWarning(other, manifest());
    expect(warning[0]).toContain("DIFFERENT pgrust commits");
    expect(warning.join("\n")).toContain(other);
    expect(warning.join("\n")).toContain(COMMIT);
    expect(warning.join("\n")).toContain("--vendor-only");
  });

  test("warns when the vendored commit is unrecorded and cannot be compared", () => {
    const warning = vendorMismatchWarning(null, manifest());
    expect(warning.join("\n")).toContain("records no commit");
    expect(warning.join("\n")).toContain("--vendor-only");
  });
});
