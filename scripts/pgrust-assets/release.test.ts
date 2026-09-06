import { describe, expect, test } from "bun:test";

import {
  isAssetTag,
  parseReleases,
  RELEASE_ASSETS,
  releaseAssetUrl,
  releaseDownloadBase,
  releasesApiUrl,
  ReleaseError,
  resolveLatestAssetTag,
  resolveReleaseTag,
} from "./release";

/** A trimmed copy of what `GET /repos/:owner/:repo/releases` returns, newest first. */
const RELEASES_JSON: unknown = [
  { tag_name: "v0.3.0", published_at: "2026-09-02T00:00:00Z", draft: false },
  { tag_name: "pgrust-assets/beefcafe", published_at: "2026-09-01T10:00:00Z", draft: true },
  { tag_name: "pgrust-assets/dab0f929", published_at: "2026-08-29T12:00:00Z", draft: false },
  { tag_name: "pgrust-assets/438c8c42", published_at: "2026-08-20T09:00:00Z", draft: false },
  "not an object",
  { name: "a release with no tag" },
];

async function unreachable(): Promise<never> {
  throw new Error("the release list must not be fetched for an explicit tag");
}

describe("RELEASE_ASSETS", () => {
  test("gzips the three large binaries and uploads vfs.json as-is", () => {
    expect(RELEASE_ASSETS.map((asset) => [asset.name, asset.target, asset.gzipped])).toEqual([
      ["postgres.wasm.gz", "postgres.wasm", true],
      ["postgres-threads.wasm.gz", "postgres-threads.wasm", true],
      ["vfs.img.gz", "vfs.img", true],
      ["vfs.json", "vfs.json", false],
    ]);
  });

  test("makes exactly the threads module optional, so a release published before it still verifies", () => {
    expect(RELEASE_ASSETS.filter((asset) => asset.optional === true).map((asset) => asset.name)).toEqual([
      "postgres-threads.wasm.gz",
    ]);
  });

  test("shares one packed image between the two modules: it is initdb output, not a build target", () => {
    const targets = RELEASE_ASSETS.map((asset) => asset.target);
    expect(targets.filter((target) => target.startsWith("vfs."))).toEqual(["vfs.img", "vfs.json"]);
  });
});

describe("urls", () => {
  test("build a GitHub release download base for a tag containing a slash", () => {
    expect(releaseDownloadBase("pgxsinkit/pglite-v-pgrust", "pgrust-assets/dab0f929")).toBe(
      "https://github.com/pgxsinkit/pglite-v-pgrust/releases/download/pgrust-assets/dab0f929",
    );
  });

  test("append an asset to a base, local override included, without doubling the slash", () => {
    const base = releaseDownloadBase("pgxsinkit/pglite-v-pgrust", "pgrust-assets/dab0f929");
    expect(releaseAssetUrl(base, "postgres.wasm.gz")).toBe(`${base}/postgres.wasm.gz`);
    expect(releaseAssetUrl("http://127.0.0.1:8080/bundle/", "SHA256SUMS")).toBe(
      "http://127.0.0.1:8080/bundle/SHA256SUMS",
    );
  });

  test("ask the API for the release list of the configured repo", () => {
    expect(releasesApiUrl("owner/name")).toBe("https://api.github.com/repos/owner/name/releases?per_page=100");
  });
});

describe("isAssetTag", () => {
  test("matches only tags in the asset namespace with a commit after it", () => {
    expect(isAssetTag("pgrust-assets/dab0f929")).toBe(true);
    expect(isAssetTag("pgrust-assets/")).toBe(false);
    expect(isAssetTag("v0.3.0")).toBe(false);
  });
});

describe("parseReleases", () => {
  test("keeps every entry with a tag and drops the rest", () => {
    expect(parseReleases(RELEASES_JSON).map((release) => release.tagName)).toEqual([
      "v0.3.0",
      "pgrust-assets/beefcafe",
      "pgrust-assets/dab0f929",
      "pgrust-assets/438c8c42",
    ]);
  });

  test("falls back to created_at when a release was never published", () => {
    const [release] = parseReleases([{ tag_name: "pgrust-assets/dab0f929", created_at: "2026-08-29T12:00:00Z" }]);
    expect(release?.publishedAt).toBe("2026-08-29T12:00:00Z");
    expect(release?.draft).toBe(false);
  });

  test("rejects a body that is not a list", () => {
    expect(() => parseReleases({ message: "Not Found" })).toThrow(ReleaseError);
  });
});

describe("resolveLatestAssetTag", () => {
  test("picks the newest published asset release, ignoring other tags and drafts", () => {
    expect(resolveLatestAssetTag(parseReleases(RELEASES_JSON))).toBe("pgrust-assets/dab0f929");
  });

  test("falls back to API order when dates are equal or absent", () => {
    const releases = parseReleases([
      { tag_name: "pgrust-assets/aaaaaaaa", published_at: "2026-08-29T12:00:00Z" },
      { tag_name: "pgrust-assets/bbbbbbbb", published_at: "2026-08-29T12:00:00Z" },
    ]);
    expect(resolveLatestAssetTag(releases)).toBe("pgrust-assets/aaaaaaaa");
    expect(resolveLatestAssetTag(parseReleases([{ tag_name: "pgrust-assets/cccccccc" }]))).toBe(
      "pgrust-assets/cccccccc",
    );
  });

  test("prefers a dated release over an undated one", () => {
    const releases = parseReleases([
      { tag_name: "pgrust-assets/aaaaaaaa" },
      { tag_name: "pgrust-assets/bbbbbbbb", published_at: "2026-08-29T12:00:00Z" },
    ]);
    expect(resolveLatestAssetTag(releases)).toBe("pgrust-assets/bbbbbbbb");
  });

  test("says what to do when the repo has no asset release at all", () => {
    expect(() => resolveLatestAssetTag(parseReleases([{ tag_name: "v0.3.0" }]))).toThrow(/pgrust:bundle/);
  });
});

describe("resolveReleaseTag", () => {
  test("returns an explicit tag without touching the network", async () => {
    expect(await resolveReleaseTag("pgrust-assets/438c8c42", unreachable)).toBe("pgrust-assets/438c8c42");
  });

  test("resolves `latest` from the release list", async () => {
    expect(await resolveReleaseTag("latest", async () => await Promise.resolve(parseReleases(RELEASES_JSON)))).toBe(
      "pgrust-assets/dab0f929",
    );
  });

  test("rejects an empty --release value", async () => {
    const thrown = await resolveReleaseTag("  ", unreachable).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(ReleaseError);
  });
});
