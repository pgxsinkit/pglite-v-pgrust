/**
 * The network half of `--release`: fetch a release's assets, verify them, and install them.
 *
 * Split out of `scripts/sync-pgrust.ts` so the thing that decides whether a download is trustworthy
 * is one function with its directories passed in, rather than a stretch of a script wired to this
 * repo's `public/pgrust/`. The script keeps the policy — which repo, which tag, what to write to
 * `SOURCE.md` — and this module keeps the transfer and the integrity rules.
 *
 * Nothing here writes outside `publicDir` and `stagingDir`, nothing here exits the process, and
 * nothing reaches `publicDir` until every asset in the release has verified: a release that goes
 * wrong on its second file must not leave one commit's `postgres.wasm` beside another's `vfs.img`,
 * a state that would run and would measure the wrong thing.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkChecksumCoverage, checkDownloadedFile, checkUnpackedFile, parseSha256Sums, sha256Hex } from "./checksums";
import type { AssetManifest, ManifestFileRecord } from "./manifest";
import { CHECKSUMS_FILE_NAME, MANIFEST_FILE_NAME, parseManifest, RELEASE_TAG_PREFIX } from "./manifest";
import type { ReleaseAssetSpec, ReleaseSummary } from "./release";
import { parseReleases, RELEASE_ASSETS, releaseAssetUrl, releasesApiUrl } from "./release";

/** How often a download reports progress, as a fraction of the total. */
const PROGRESS_STEP = 0.1;

/** Below this, a download is over before a progress line would be read; only the total is printed. */
const PROGRESS_FLOOR = 4 * 1024 * 1024;

/** Raised for anything that stops a release being installed; the message is what the user sees. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/** Where a line of progress goes; the script passes `console.log`. */
export type Log = (line: string) => void;

/** One asset that verified and was installed. */
export interface InstalledAsset {
  /** Name as uploaded. */
  readonly name: string;
  /** Path relative to `publicDir`. */
  readonly target: string;
  /** Size once unpacked. */
  readonly bytes: number;
}

export interface ReleaseBundleRequest {
  /** Directory URL the assets hang off: a GitHub download base, or a local override. */
  readonly base: string;
  /** The tag asked for, which the manifest is checked against. */
  readonly tag: string;
  /** Where verified assets are installed. */
  readonly publicDir: string;
  /** Scratch directory for the download; emptied before use and removed after. */
  readonly stagingDir: string;
  readonly log: Log;
}

export interface ReleaseBundle {
  readonly manifest: AssetManifest;
  readonly installed: readonly InstalledAsset[];
  /** Optional assets this release does not carry; each one's `absentNote` says what that costs. */
  readonly absent: readonly ReleaseAssetSpec[];
  /** Things the user should read but that did not stop the install. */
  readonly warnings: readonly string[];
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function fetchOrFail(url: string, what: string, headers?: Readonly<Record<string, string>>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, headers === undefined ? undefined : { headers });
  } catch (error) {
    throw new DownloadError(
      `could not fetch ${what} from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new DownloadError(`could not fetch ${what} from ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  return response;
}

/** Stream a URL to `destination`, printing progress; returns the size and digest of what landed. */
async function download(
  url: string,
  destination: string,
  label: string,
  log: Log,
): Promise<{ bytes: number; sha256: string }> {
  const response = await fetchOrFail(url, label);
  const declared = Number(response.headers.get("content-length") ?? "0");
  const body = response.body;
  if (body === null) {
    throw new DownloadError(`${url} returned no body`);
  }
  const hasher = createHash("sha256");
  const writer = Bun.file(destination).writer();
  let written = 0;
  let nextReport = declared > PROGRESS_FLOOR ? declared * PROGRESS_STEP : Number.POSITIVE_INFINITY;
  for await (const chunk of body) {
    const bytes = chunk as Uint8Array;
    hasher.update(bytes);
    // FileSink.write returns a promise only when it has to flush; awaiting it is the backpressure.
    const flushed = writer.write(bytes);
    if (typeof flushed !== "number") {
      await flushed;
    }
    written += bytes.length;
    if (written >= nextReport) {
      log(`    ${label}: ${megabytes(written)} / ${megabytes(declared)}`);
      nextReport += declared * PROGRESS_STEP;
    }
  }
  await writer.end();
  log(`    ${label}: ${megabytes(written)} downloaded`);
  return { bytes: written, sha256: hasher.digest("hex") };
}

async function fetchText(url: string, what: string): Promise<string> {
  const response = await fetchOrFail(url, what);
  return await response.text();
}

/** The releases of a repo, for `--release latest`. */
export async function fetchReleaseList(repository: string, log: Log): Promise<readonly ReleaseSummary[]> {
  const url = releasesApiUrl(repository);
  log(`Resolving the newest ${RELEASE_TAG_PREFIX}* release from ${url}`);
  const response = await fetchOrFail(url, "the release list", {
    accept: "application/vnd.github+json",
    "user-agent": "pglite-v-pgrust sync:pgrust",
  });
  return parseReleases(await response.json());
}

/** Throw with every integrity problem at once: a partial list invites a second wasted download. */
function requireNoProblems(problems: readonly string[], what: string): void {
  if (problems.length === 0) {
    return;
  }
  throw new DownloadError(
    [
      what,
      ...problems.map((problem) => `  ${problem}`),
      "the download does not match what the release says it is — nothing was written to public/pgrust/",
    ].join("\n"),
  );
}

/** The manifest entry for one expected asset; null for an optional one this release predates. */
function manifestFileFor(manifest: AssetManifest, spec: ReleaseAssetSpec): ManifestFileRecord | null {
  const file = manifest.files.find((candidate) => candidate.name === spec.name);
  if (file === undefined) {
    if (spec.optional === true) {
      return null;
    }
    throw new DownloadError(
      `release ${manifest.tag} has no "${spec.name}" — it was not built by \`bun run pgrust:bundle\``,
    );
  }
  if (spec.gzipped && file.unpacked === undefined) {
    throw new DownloadError(`release ${manifest.tag} describes "${spec.name}" without the bytes it unpacks to`);
  }
  return file;
}

/** Verify a staged download, unpack it if it is a gzip, and leave it beside its gzip in staging. */
function unpackStaged(
  file: ManifestFileRecord,
  spec: ReleaseAssetSpec,
  stagedPath: string,
  stagingDir: string,
  log: Log,
): { readonly path: string; readonly bytes: number } {
  const staged = new Uint8Array(readFileSync(stagedPath));
  const unpacked = spec.gzipped ? Bun.gunzipSync(staged) : staged;
  requireNoProblems(
    checkUnpackedFile(file, { bytes: unpacked.length, sha256: sha256Hex(unpacked) }),
    `${spec.target} is not the file the manifest describes`,
  );
  // Nested targets (the store bundle lives under host/vendor/) get the same shape in staging, so a
  // promotion is one copy per file with no name mangling in between.
  const unpackedPath = join(stagingDir, spec.target);
  mkdirSync(dirname(unpackedPath), { recursive: true });
  writeFileSync(unpackedPath, unpacked);
  log(`    ${spec.target}: ${megabytes(unpacked.length)} verified`);
  return { path: unpackedPath, bytes: unpacked.length };
}

/**
 * Download, verify and install one release's assets.
 *
 * An optional asset the release does not carry is reported rather than failed on, and any stale copy
 * of it is removed: leaving an earlier sync's file behind would run one commit's module beside
 * another commit's, which is the exact state `SOURCE.md` exists to rule out.
 */
export async function fetchReleaseBundle(request: ReleaseBundleRequest): Promise<ReleaseBundle> {
  const { base, tag, publicDir, stagingDir, log } = request;
  const warnings: string[] = [];

  const manifest = parseManifest(
    JSON.parse(await fetchText(releaseAssetUrl(base, MANIFEST_FILE_NAME), MANIFEST_FILE_NAME)) as unknown,
  );
  const checksums = parseSha256Sums(await fetchText(releaseAssetUrl(base, CHECKSUMS_FILE_NAME), CHECKSUMS_FILE_NAME));
  requireNoProblems(
    checkChecksumCoverage(manifest, checksums),
    `${MANIFEST_FILE_NAME} and ${CHECKSUMS_FILE_NAME} disagree`,
  );
  if (manifest.tag !== tag) {
    warnings.push(`the manifest names ${manifest.tag}, not ${tag} — using the manifest's provenance`);
  }
  log(`  pgrust ${manifest.pgrust.commit} on ${manifest.pgrust.branch}`);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const absent: ReleaseAssetSpec[] = [];
  const staged: { readonly spec: ReleaseAssetSpec; readonly path: string; readonly bytes: number }[] = [];
  for (const spec of RELEASE_ASSETS) {
    const file = manifestFileFor(manifest, spec);
    if (file === null) {
      absent.push(spec);
      rmSync(join(publicDir, spec.target), { force: true });
      continue;
    }
    const stagedPath = join(stagingDir, spec.name);
    log(`  ${spec.name} (${megabytes(file.bytes)})`);
    const landed = await download(releaseAssetUrl(base, spec.name), stagedPath, spec.name, log);
    requireNoProblems(checkDownloadedFile(file, checksums, landed), `${spec.name} failed verification`);
    staged.push({ spec, ...unpackStaged(file, spec, stagedPath, stagingDir, log) });
  }

  const installed: InstalledAsset[] = [];
  for (const entry of staged) {
    const destination = join(publicDir, entry.spec.target);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(entry.path));
    installed.push({ name: entry.spec.name, target: entry.spec.target, bytes: statSync(destination).size });
  }
  rmSync(stagingDir, { recursive: true, force: true });

  return { manifest, installed, absent, warnings };
}
