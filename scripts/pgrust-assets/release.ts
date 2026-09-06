/**
 * Where the pgrust wasm assets live once they are published, and how a tag is chosen.
 *
 * The assets are ~90 MB of build output — gitignored here, published as GitHub Release assets of
 * this repo under `pgrust-assets/<short-commit>` so a clean clone can get a working pgrust column
 * without a pgrust checkout or a Rust toolchain. One release is one pgrust commit.
 *
 * Pure URL and JSON handling only: the fetching lives in `scripts/sync-pgrust.ts`.
 */

import { RELEASE_TAG_PREFIX } from "./manifest";

/** The repo whose releases carry the assets; `PGLITE_V_PGRUST_RELEASE_REPO` overrides it. */
export const DEFAULT_RELEASE_REPOSITORY = "pgxsinkit/pglite-v-pgrust";

/** The `--release` value that means "resolve the newest asset release". */
export const LATEST_RELEASE = "latest";

/** One file of a release, and what it becomes in `public/pgrust/`. */
export interface ReleaseAssetSpec {
  /** Name as uploaded. */
  readonly name: string;
  /** Name in `public/pgrust/` once unpacked. */
  readonly target: string;
  /** Whether the uploaded file is a gzip of `target`. */
  readonly gzipped: boolean;
  /**
   * Whether a release may legitimately not carry this file.
   *
   * Exactly one is: `postgres-threads.wasm` arrived after the first releases were published, and a
   * release from before it is still a complete, verifiable set for the six columns that existed
   * then. Downloading one leaves the two pgrust Threads columns reporting the asset missing, which
   * is what they already report on a clone that has never synced — not a failed download.
   */
  readonly optional?: boolean;
}

/**
 * The four assets, in upload order.
 *
 * The two wasm modules and `vfs.img` are gzipped: together they are ~131 MB raw and ~27 MB
 * compressed, which is the difference between a download a contributor will do and one they will
 * not. `vfs.json` is 139 KB of JSON and is uploaded plain so it can be read straight from the
 * release page — and it is shared by both modules, because the packed image is `initdb` output and
 * has no target in it.
 */
export const RELEASE_ASSETS: readonly ReleaseAssetSpec[] = [
  { name: "postgres.wasm.gz", target: "postgres.wasm", gzipped: true },
  { name: "postgres-threads.wasm.gz", target: "postgres-threads.wasm", gzipped: true, optional: true },
  { name: "vfs.img.gz", target: "vfs.img", gzipped: true },
  { name: "vfs.json", target: "vfs.json", gzipped: false },
];

/** A release as much of the GitHub API response as this repo cares about. */
export interface ReleaseSummary {
  readonly tagName: string;
  /** ISO-8601, or null for a release GitHub has not published (or did not date). */
  readonly publishedAt: string | null;
  readonly draft: boolean;
}

/** Raised when a release cannot be resolved; the message is what the user sees. */
export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** `https://github.com/<repo>/releases/download/<tag>` — the prefix every asset URL is built on. */
export function releaseDownloadBase(repository: string, tag: string): string {
  return `https://github.com/${repository}/releases/download/${tag.split("/").map(encodeURIComponent).join("/")}`;
}

/** The URL of one file under a download base, which may be a local override. */
export function releaseAssetUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(name)}`;
}

/** The unauthenticated GitHub API listing used to resolve `--release latest`. */
export function releasesApiUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/releases?per_page=100`;
}

/** True for a tag in the asset namespace. */
export function isAssetTag(tag: string): boolean {
  return tag.startsWith(RELEASE_TAG_PREFIX) && tag.length > RELEASE_TAG_PREFIX.length;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Read a GitHub `GET /repos/:owner/:repo/releases` body into summaries.
 *
 * Entries that are not objects, or that carry no `tag_name`, are dropped rather than thrown on: the
 * API is free to grow fields, and one odd entry must not stop `latest` resolving.
 */
export function parseReleases(value: unknown): readonly ReleaseSummary[] {
  if (!Array.isArray(value)) {
    throw new ReleaseError("the GitHub releases API did not return a list");
  }
  const summaries: ReleaseSummary[] = [];
  const entries: readonly unknown[] = value;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const tagName = optionalString(record["tag_name"]);
    if (tagName === null) {
      continue;
    }
    summaries.push({
      tagName,
      publishedAt: optionalString(record["published_at"]) ?? optionalString(record["created_at"]),
      draft: record["draft"] === true,
    });
  }
  return summaries;
}

/**
 * The newest published `pgrust-assets/*` tag.
 *
 * Newest means most recently published, not highest-sorting: the tag's suffix is a commit, which
 * has no order. Drafts are skipped (they have no downloadable assets), and releases the API dated
 * identically — or not at all — keep the order the API returned them in, which is already newest
 * first.
 */
export function resolveLatestAssetTag(releases: readonly ReleaseSummary[]): string {
  const candidates = releases
    .map((release, index) => ({ release, index }))
    .filter(({ release }) => !release.draft && isAssetTag(release.tagName));
  if (candidates.length === 0) {
    throw new ReleaseError(
      `no published ${RELEASE_TAG_PREFIX}* release found — publish one with \`bun run pgrust:bundle\`, ` +
        "or pass an explicit --release <tag>",
    );
  }
  candidates.sort((left, right) => {
    const leftTime = left.release.publishedAt === null ? null : Date.parse(left.release.publishedAt);
    const rightTime = right.release.publishedAt === null ? null : Date.parse(right.release.publishedAt);
    const leftValid = leftTime !== null && !Number.isNaN(leftTime);
    const rightValid = rightTime !== null && !Number.isNaN(rightTime);
    if (leftValid && rightValid && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    if (leftValid !== rightValid) {
      return leftValid ? -1 : 1;
    }
    return left.index - right.index;
  });
  const newest = candidates[0];
  if (newest === undefined) {
    throw new ReleaseError("no release to resolve");
  }
  return newest.release.tagName;
}

/**
 * Turn a `--release` value into a tag, resolving `latest` against a releases listing.
 *
 * `fetchReleases` is only called for `latest`, so an explicit tag never touches the network.
 */
export async function resolveReleaseTag(
  requested: string,
  fetchReleases: () => Promise<readonly ReleaseSummary[]>,
): Promise<string> {
  if (requested.trim() === "") {
    throw new ReleaseError("--release needs a tag, or `latest`");
  }
  if (requested !== LATEST_RELEASE) {
    return requested;
  }
  return resolveLatestAssetTag(await fetchReleases());
}
