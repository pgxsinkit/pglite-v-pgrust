import { describe, expect, test } from "bun:test";

import type { AssetManifest } from "./manifest";
import { buildManifest } from "./manifest";
import { ghReleaseCommand, releaseNotesMarkdown, releaseTitle, releaseUploadNames } from "./notes";

const COMMIT = "dab0f92940dcf893d981f766f34baf776b59ed33";

const MANIFEST: AssetManifest = buildManifest({
  tag: "pgrust-assets/dab0f929",
  commit: COMMIT,
  shortCommit: "dab0f92940",
  branch: "bench/parse-source-text-borrow",
  upstreamCommit: "438c8c420b96b23ca61927ba57e608839f86e935",
  profile: "wasm-release",
  target: "wasm32-wasip1",
  toolchain: "nightly-2026-07-17",
  initdb: "PostgreSQL 18",
  builtAt: "2026-08-29T11:19:00.000Z",
  files: [
    {
      name: "postgres.wasm.gz",
      bytes: 11_534_336,
      sha256: "a".repeat(64),
      unpacked: { name: "postgres.wasm", bytes: 46_094_747, sha256: "b".repeat(64) },
    },
    { name: "vfs.json", bytes: 138_836, sha256: "c".repeat(64) },
  ],
});

describe("releaseUploadNames", () => {
  test("uploads the assets plus both records", () => {
    expect(releaseUploadNames(MANIFEST)).toEqual(["postgres.wasm.gz", "vfs.json", "SHA256SUMS", "manifest.json"]);
  });
});

describe("releaseTitle", () => {
  test("names the commit and the branch", () => {
    expect(releaseTitle(MANIFEST)).toBe("pgrust wasm assets dab0f92940 (bench/parse-source-text-borrow)");
  });
});

describe("releaseNotesMarkdown", () => {
  test("leads with the sync command a consumer runs", () => {
    expect(releaseNotesMarkdown(MANIFEST)).toContain("bun run sync:pgrust --release pgrust-assets/dab0f929");
  });

  test("carries the AGPL source statement: branch, commit and upstream base", () => {
    const notes = releaseNotesMarkdown(MANIFEST);
    expect(notes).toContain("AGPL-3.0");
    expect(notes).toContain("https://github.com/pgxsinkit/pgrust/tree/bench/parse-source-text-borrow");
    expect(notes).toContain(COMMIT);
    expect(notes).toContain("438c8c420b96b23ca61927ba57e608839f86e935");
  });

  test("carries the build recipe and the sizes, unpacked included", () => {
    const notes = releaseNotesMarkdown(MANIFEST);
    expect(notes).toContain("PGRUST_WASM_PROFILE=wasm-release wasm/wasm-build.sh");
    expect(notes).toContain("wasm32-wasip1");
    expect(notes).toContain("nightly-2026-07-17");
    expect(notes).toContain("initdb` from PostgreSQL 18");
    expect(notes).toContain("| `postgres.wasm.gz` | 11.0 MiB | postgres.wasm (44.0 MiB) |");
    expect(notes).toContain("| `vfs.json` | 136 KiB | — |");
  });
});

describe("ghReleaseCommand", () => {
  test("publishes the tag with the generated notes and every uploaded file", () => {
    const command = ghReleaseCommand(
      MANIFEST,
      "pgxsinkit/pglite-v-pgrust",
      "tmp/pgrust-assets/pgrust-assets-dab0f929",
      "tmp/pgrust-assets/pgrust-assets-dab0f929/NOTES.md",
    );
    expect(command).toContain("gh release create pgrust-assets/dab0f929");
    expect(command).toContain("--repo pgxsinkit/pglite-v-pgrust");
    expect(command).toContain("--notes-file tmp/pgrust-assets/pgrust-assets-dab0f929/NOTES.md");
    for (const name of releaseUploadNames(MANIFEST)) {
      expect(command).toContain(`tmp/pgrust-assets/pgrust-assets-dab0f929/${name}`);
    }
  });

  test("quotes the title, which contains spaces and parentheses", () => {
    const command = ghReleaseCommand(MANIFEST, "owner/name", "dir", "dir/NOTES.md");
    expect(command).toContain("--title 'pgrust wasm assets dab0f92940 (bench/parse-source-text-borrow)'");
  });
});
