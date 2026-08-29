/**
 * How a dependency's version is reported in the environment header.
 *
 * Most dependencies are plain semver and their own manifest is the truth. wa-sqlite is not: npm
 * only ever received 1.0.0, upstream releases by GitHub tag, and the tagged tree's manifest still
 * says `1.1.1` at tag `v1.1.2`. Reporting the manifest there would be reporting a version that was
 * never released, so for a git dependency the specifier's ref is the truth and the manifest is only
 * the fallback.
 *
 * Pure string handling, called from `vite.config.ts` at build time.
 */

/** Specifier prefixes that mean "resolved from a git host", where the ref after `#` is the version. */
const GIT_SPECIFIER = /^(?:github:|gitlab:|bitbucket:|git\+|git:)/;

/** How a ref is labelled, so a header never shows a bare tag that looks like a published version. */
function sourceLabel(specifier: string): string {
  return specifier.startsWith("github:") ? "github" : "git";
}

/**
 * The version to report for a dependency installed as `specifier`, whose installed manifest says
 * `manifestVersion`.
 *
 * A git specifier reports its pinned ref, e.g. `github:owner/repo#v1.1.2` -> `v1.1.2 (github)`.
 * Anything else — a plain semver range, a missing specifier, a git URL with no ref — falls back to
 * the manifest.
 */
export function describeDependencyVersion(specifier: string | undefined, manifestVersion: string): string {
  if (specifier === undefined || !GIT_SPECIFIER.test(specifier)) {
    return manifestVersion;
  }
  const separator = specifier.lastIndexOf("#");
  if (separator === -1) {
    return manifestVersion;
  }
  const ref = specifier.slice(separator + 1).trim();
  return ref === "" ? manifestVersion : `${ref} (${sourceLabel(specifier)})`;
}
