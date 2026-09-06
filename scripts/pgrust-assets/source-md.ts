/**
 * `src/vendor/pgrust/SOURCE.md` — the provenance file, which records three different things that
 * must not be conflated:
 *
 * 1. the **vendored host JS**, copied byte-verbatim from a pgrust checkout and committed here;
 * 2. the **binary assets** in `public/pgrust/`, which are gitignored and now normally arrive from a
 *    GitHub Release rather than from that checkout; and
 * 3. the **pre-release store bundle** the broker column loads, which is neither pgrust nor a
 *    published package but a build out of a pgxsinkit checkout.
 *
 * The first two can be from different pgrust commits — a release download does not touch the
 * vendored JS — and the third is from a different repository entirely. So (2) and (3) are marked
 * blocks that each sync mode rewrites without disturbing the others, and a commit mismatch between
 * the vendored JS and the binaries is reported loudly rather than papered over.
 *
 * Pure string handling; the callers do the file I/O.
 */

import type { AssetManifest } from "./manifest";
import { pgrustCommitUrl, pgrustSourceUrl } from "./manifest";

/** Fences the assets half of `SOURCE.md`; everything outside them describes the vendored host JS. */
export const ASSETS_BEGIN = "<!-- pgrust-assets:begin -->";
export const ASSETS_END = "<!-- pgrust-assets:end -->";

/**
 * Fences the record of the **pre-release** `@pgxsinkit/pglite-opfs-repacked` build the broker
 * column loads. Its own block because it is a third provenance: not pgrust, not a release of this
 * repo, but a bundle copied out of a pgxsinkit checkout that no published version corresponds to.
 */
export const STORE_BUNDLE_BEGIN = "<!-- store-bundle:begin -->";
export const STORE_BUNDLE_END = "<!-- store-bundle:end -->";

function blockPattern(begin: string, end: string): RegExp {
  return new RegExp(`\\n*${begin}\\n([\\s\\S]*?)\\n${end}\\n*`);
}

const ASSETS_BLOCK = blockPattern(ASSETS_BEGIN, ASSETS_END);
const STORE_BUNDLE_BLOCK = blockPattern(STORE_BUNDLE_BEGIN, STORE_BUNDLE_END);

/** The commit recorded for the vendored host JS, or null when the file does not name one. */
export function readVendorCommit(markdown: string): string | null {
  const beforeBlocks = (markdown.split(STORE_BUNDLE_BEGIN)[0] ?? "").split(ASSETS_BEGIN)[0] ?? "";
  const match = /^- Commit: `([0-9a-f]{7,40})`/m.exec(beforeBlocks);
  return match?.[1] ?? null;
}

/** One marked block's contents, or null when the file has none yet. */
function extractSection(markdown: string, pattern: RegExp): string | null {
  return pattern.exec(markdown)?.[1] ?? null;
}

/**
 * Put `section` in one marked block, replacing any existing one; null removes the block.
 *
 * The block is always re-appended at the end, so a caller that rewrites several blocks in a fixed
 * order gets the same file order every time regardless of what it found. The rest of the file is
 * left byte-for-byte alone, which is what lets `--release` update the assets provenance without
 * claiming anything new about the vendored JS or about the store bundle.
 */
function replaceSection(
  markdown: string,
  pattern: RegExp,
  fences: readonly [string, string],
  section: string | null,
): string {
  const withoutBlock = markdown.replace(pattern, "\n");
  if (section === null) {
    return withoutBlock.endsWith("\n") ? withoutBlock : `${withoutBlock}\n`;
  }
  const body = withoutBlock.replace(/\n+$/, "");
  return `${body}\n\n${fences[0]}\n${section}\n${fences[1]}\n`;
}

/** The assets block's contents, or null when the file has none yet. */
export function extractAssetsSection(markdown: string): string | null {
  return extractSection(markdown, ASSETS_BLOCK);
}

/** Put `section` in the assets block, replacing any existing one; null removes the block. */
export function replaceAssetsSection(markdown: string, section: string | null): string {
  return replaceSection(markdown, ASSETS_BLOCK, [ASSETS_BEGIN, ASSETS_END], section);
}

/** The store-bundle block's contents, or null when the file has none yet. */
export function extractStoreBundleSection(markdown: string): string | null {
  return extractSection(markdown, STORE_BUNDLE_BLOCK);
}

/** Put `section` in the store-bundle block, replacing any existing one; null removes the block. */
export function replaceStoreBundleSection(markdown: string, section: string | null): string {
  return replaceSection(markdown, STORE_BUNDLE_BLOCK, [STORE_BUNDLE_BEGIN, STORE_BUNDLE_END], section);
}

/**
 * The assets block for a download from a GitHub Release.
 *
 * `fetchedFrom` is the `PGLITE_V_PGRUST_RELEASE_BASE_URL` override, when one was used. The release
 * link stays canonical either way — it is the provenance of the bytes, and it is what a reader of
 * this committed file needs — but a download that did not come from GitHub says so on its own line
 * rather than quietly reading as one that did.
 */
export function releaseAssetsSection(
  manifest: AssetManifest,
  releaseUrl: string,
  syncedAt: string,
  fetchedFrom: string | null,
): string {
  return [
    "## Binary assets in `public/pgrust/`",
    "",
    `Downloaded by \`bun run sync:pgrust --release ${manifest.tag}\` — **not** from the checkout above.`,
    "They are gitignored build outputs; only this record of them is committed.",
    "",
    `- Release: [\`${manifest.tag}\`](${releaseUrl})`,
    `- pgrust commit: [\`${manifest.pgrust.commit}\`](${pgrustCommitUrl(manifest.pgrust)})`,
    `- Branch: [\`${manifest.pgrust.branch}\`](${pgrustSourceUrl(manifest.pgrust)})`,
    `- Upstream base: \`${manifest.pgrust.upstream.commit}\` (${manifest.pgrust.upstream.repository})`,
    `- Build: \`${manifest.build.profile}\` / \`${manifest.build.target}\` / \`${manifest.build.toolchain}\``,
    ...(manifest.build.threadsTarget === undefined
      ? []
      : [
          `- Threads build: \`${manifest.build.profile}\` / \`${manifest.build.threadsTarget}\` (postgres-threads.wasm)`,
        ]),
    `- VFS: \`initdb\` from ${manifest.vfs.initdb}, built ${manifest.vfs.builtAt}`,
    `- Downloaded: ${syncedAt}`,
    ...(fetchedFrom === null ? [] : [`- Fetched from: \`${fetchedFrom}\` (PGLITE_V_PGRUST_RELEASE_BASE_URL)`]),
    "",
    "pgrust is AGPL-3.0-only. The complete corresponding source for these binaries is the commit",
    "linked above; the release's `manifest.json` records the same thing in machine-readable form.",
  ].join("\n");
}

/** The assets block for a copy out of a local pgrust checkout. */
export function checkoutAssetsSection(checkoutDir: string, version: string, syncedAt: string): string {
  return [
    "## Binary assets in `public/pgrust/`",
    "",
    "Copied by `bun run sync:pgrust` from a local pgrust checkout. They are gitignored build",
    "outputs; only this record of them is committed.",
    "",
    `- Source: \`${checkoutDir}\``,
    `- Version: \`${version}\``,
    `- Copied: ${syncedAt}`,
    "",
    "pgrust is AGPL-3.0-only; these binaries were built locally from the checkout named above.",
  ].join("\n");
}

/** Where the pre-release store bundle came from, in the detail a reader needs to reproduce it. */
export interface StoreBundleProvenance {
  /** The pgxsinkit checkout it was copied out of. */
  readonly checkoutDir: string;
  /** The pgxsinkit commit that built it. */
  readonly commit: string;
  /** Whether that checkout had uncommitted changes when the copy was made. */
  readonly dirty: boolean;
  /** The version in the package's own manifest — a placeholder in that repo, hence "pre-release". */
  readonly packageVersion: string;
  /** Where it landed, relative to the repo root. */
  readonly target: string;
  readonly bytes: number;
  readonly syncedAt: string;
}

/**
 * The block recording the **pre-release** store bundle the broker columns run on.
 *
 * The published `@pgxsinkit/pglite-opfs-repacked` this repo depends on carries neither the sync
 * broker nor the WASI adapter those columns need, so they run a bundle built from a checkout
 * instead. That is a materially different claim from "the package on npm", and the two must never
 * be read as one: each of those Configurations' labels says `pre-release store`, and this block is
 * where the exact commit behind that label is written down.
 */
export function storeBundleSection(provenance: StoreBundleProvenance): string {
  return [
    "## Pre-release store bundle in `public/pgrust/host/`",
    "",
    "Copied by `bun run sync:pgrust` from a **pgxsinkit checkout**, not from npm. The three",
    "`pgrust Threads` broker columns are the only things that load it — the Memory one on the store's",
    "memory port, the two OPFS repacked ones on its OPFS port — and it is a gitignored build output;",
    "only this record of it is committed.",
    "",
    `- Package: \`@pgxsinkit/pglite-opfs-repacked\` (manifest version \`${provenance.packageVersion}\`)`,
    `- Commit: \`${provenance.commit}\``,
    `- Source: \`${provenance.checkoutDir}\``,
    `- Working tree: ${provenance.dirty ? "dirty at sync time" : "clean"}`,
    `- Copied to: \`${provenance.target}\` (${provenance.bytes} bytes)`,
    `- Copied: ${provenance.syncedAt}`,
    "",
    "The `RepackedSyncBroker` + `createWasiPreview1Fs` pair those columns need is **not** in any",
    "published version of the package, so no npm release corresponds to these bytes. The two",
    "`PGlite OPFS repacked` columns are unaffected: they run the published dependency in",
    "`package.json`.",
  ].join("\n");
}

/**
 * Whether the host JS and the binary are from the same pgrust commit.
 *
 * `--release` deliberately leaves the vendored JS alone, so a release built from a newer pgrust than
 * the JS in this repo is possible and is not necessarily broken — the wire protocol rarely moves.
 * It is also exactly the state in which a benchmark result means something other than what it says,
 * so it is called out in full rather than left to be discovered.
 *
 * Returns the lines to print; empty means the two agree.
 */
export function vendorMismatchWarning(vendorCommit: string | null, manifest: AssetManifest): readonly string[] {
  const assetCommit = manifest.pgrust.commit;
  if (vendorCommit === null) {
    return [
      "src/vendor/pgrust/SOURCE.md records no commit for the vendored host JS, so it cannot be",
      `checked against the binary's ${assetCommit.slice(0, 10)}. Re-run \`bun run sync:pgrust --vendor-only\``,
      "against a pgrust checkout to restore the record.",
    ];
  }
  const agree = assetCommit.startsWith(vendorCommit) || vendorCommit.startsWith(assetCommit);
  if (agree) {
    return [];
  }
  return [
    "the vendored host JS and the downloaded binary are from DIFFERENT pgrust commits:",
    `  host JS (src/vendor/pgrust/*.js): ${vendorCommit}`,
    `  binary  (public/pgrust/*):        ${assetCommit}`,
    "The pgrust column will run one commit's JavaScript against another commit's wasm. If the wire",
    "session or the VFS layout moved between them, the Run will fail or, worse, quietly measure",
    `something else. Re-vendor from ${manifest.pgrust.branch} @ ${assetCommit.slice(0, 10)}:`,
    "  PGRUST_DIR=/path/to/pgrust bun run sync:pgrust --vendor-only",
  ];
}
