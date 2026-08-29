/**
 * The release notes and the `gh release create` line that publishes a bundle.
 *
 * pgrust is AGPL-3.0: distributing the compiled wasm obliges this repo to point at the complete
 * corresponding source, so the notes lead with the exact branch, the exact commit and the exact
 * build recipe rather than mentioning them at the bottom. The notes are generated with the bundle
 * and uploaded with `--notes-file`, so what a release says can never drift from what it contains.
 */

import type { AssetManifest } from "./manifest";
import { CHECKSUMS_FILE_NAME, MANIFEST_FILE_NAME, pgrustCommitUrl, pgrustSourceUrl } from "./manifest";

/** Every file uploaded to a release, in upload order: the assets, then the two records. */
export function releaseUploadNames(manifest: AssetManifest): readonly string[] {
  return [...manifest.files.map((file) => file.name), CHECKSUMS_FILE_NAME, MANIFEST_FILE_NAME];
}

/** The release title. */
export function releaseTitle(manifest: AssetManifest): string {
  return `pgrust wasm assets ${manifest.pgrust.shortCommit} (${manifest.pgrust.branch})`;
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

/** `NOTES.md`: what the release is, where its source is, and how to consume it. */
export function releaseNotesMarkdown(manifest: AssetManifest): string {
  const fileRows = manifest.files.map((file) => {
    const unpacked = file.unpacked;
    const unpackedCell = unpacked === undefined ? "—" : `${unpacked.name} (${formatBytes(unpacked.bytes)})`;
    return `| \`${file.name}\` | ${formatBytes(file.bytes)} | ${unpackedCell} |`;
  });
  return [
    `Prebuilt pgrust WebAssembly assets for the \`pgrust Memory\` column of this benchmark, so a clean`,
    "clone needs no pgrust checkout and no Rust toolchain:",
    "",
    "```sh",
    `bun run sync:pgrust --release ${manifest.tag}`,
    "```",
    "",
    "That downloads these files, verifies every SHA-256 against `SHA256SUMS` **and** the unpacked",
    "sizes and digests in `manifest.json`, and writes `public/pgrust/`.",
    "",
    "## Source (AGPL-3.0)",
    "",
    "pgrust is AGPL-3.0-only. The complete corresponding source for the binaries in this release is:",
    "",
    `- **Branch:** ${pgrustSourceUrl(manifest.pgrust)}`,
    `- **Commit:** [\`${manifest.pgrust.commit}\`](${pgrustCommitUrl(manifest.pgrust)})`,
    `- **Upstream base:** \`${manifest.pgrust.upstream.commit}\` (${manifest.pgrust.upstream.repository})`,
    "",
    "## Build recipe",
    "",
    `- Profile: \`${manifest.build.profile}\``,
    `- Target: \`${manifest.build.target}\``,
    `- Toolchain: \`${manifest.build.toolchain}\``,
    `- VFS: \`initdb\` from ${manifest.vfs.initdb}, built ${manifest.vfs.builtAt}`,
    "",
    "```sh",
    `git clone ${manifest.pgrust.repository} && cd pgrust`,
    `git checkout ${manifest.pgrust.commit}`,
    `PGRUST_WASM_PROFILE=${manifest.build.profile} wasm/wasm-build.sh   # compiles postgres.wasm`,
    "wasm/build.sh                                         # packs vfs.img + vfs.json beside it",
    "```",
    "",
    "## Files",
    "",
    "| Asset | Uploaded | Unpacks to |",
    "| ----- | -------: | ---------- |",
    ...fileRows,
    `| \`${CHECKSUMS_FILE_NAME}\` | — | checksums of the assets as uploaded |`,
    `| \`${MANIFEST_FILE_NAME}\` | — | this provenance, machine-readable |`,
    "",
  ].join("\n");
}

/** A shell-quoted argument, single quotes only where they are needed. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `gh release create` command that publishes a bundle.
 *
 * Printed, never run: publishing is a deliberate act by a human with credentials, and an AGPL
 * source statement should be read by that human before it goes out.
 */
export function ghReleaseCommand(
  manifest: AssetManifest,
  repository: string,
  bundleDir: string,
  notesFile: string,
): string {
  const files = releaseUploadNames(manifest).map((name) => `${bundleDir}/${name}`);
  const lines = [
    `gh release create ${shellQuote(manifest.tag)}`,
    `--repo ${shellQuote(repository)}`,
    `--title ${shellQuote(releaseTitle(manifest))}`,
    `--notes-file ${shellQuote(notesFile)}`,
    ...files.map(shellQuote),
  ];
  return lines.join(" \\\n  ");
}
