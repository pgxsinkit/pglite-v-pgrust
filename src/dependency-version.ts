/**
 * How a dependency's version is reported in the environment header.
 *
 * Most dependencies are plain semver and their own manifest is the truth. Two kinds are not, and in
 * both the specifier this repo wrote down outranks the manifest of whatever ended up installed:
 *
 * - **A git dependency.** npm only ever received wa-sqlite 1.0.0; upstream releases by GitHub tag,
 *   and the tagged tree's manifest still says `1.1.1` at tag `v1.1.2`. Reporting the manifest there
 *   would be reporting a version that was never released, so the pinned ref wins.
 * - **An `npm:` alias.** PGlite is installed as `@electric-sql/pglite`:
 *   `npm:@pgxsinkit/pglite@0.5.5-pgx.2`, so the store package's peer and this app resolve one single
 *   copy — the pgx fork. The dependency key is then not the installed package's name, and the
 *   version this repo pinned is stated in the alias, not in the key.
 *
 * Pure string handling, called from `vite.config.ts` at build time.
 */

/** Specifier prefixes that mean "resolved from a git host", where the ref after `#` is the version. */
const GIT_SPECIFIER = /^(?:github:|gitlab:|bitbucket:|git\+|git:)/;

/** `npm:<name>@<version>`: another package installed under this dependency's key. */
const NPM_ALIAS_PREFIX = "npm:";

/** An exact version, the only kind an alias can be reported from; a range says nothing precise. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * The exact version an `npm:` alias pins, or undefined for a range, a missing version or a
 * scope-only `@`. A scoped alias target starts with `@`, hence the last separator rather than the
 * first, and hence index 0 not counting as one.
 */
function aliasVersion(specifier: string): string | undefined {
  const target = specifier.slice(NPM_ALIAS_PREFIX.length);
  const separator = target.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  const version = target.slice(separator + 1).trim();
  return EXACT_VERSION.test(version) ? version : undefined;
}

/** How a ref is labelled, so a header never shows a bare tag that looks like a published version. */
function sourceLabel(specifier: string): string {
  return specifier.startsWith("github:") ? "github" : "git";
}

/**
 * The version to report for a dependency installed as `specifier`, whose installed manifest says
 * `manifestVersion`.
 *
 * A git specifier reports its pinned ref, e.g. `github:owner/repo#v1.1.2` -> `v1.1.2 (github)`. An
 * `npm:` alias reports the exact version it pins, e.g. `npm:@pgxsinkit/pglite@0.5.5-pgx.2` ->
 * `0.5.5-pgx.2`. Anything else — a plain semver range, a missing specifier, a git URL with no ref,
 * an alias pinning a range — falls back to the manifest.
 */
export function describeDependencyVersion(specifier: string | undefined, manifestVersion: string): string {
  if (specifier === undefined) {
    return manifestVersion;
  }
  if (specifier.startsWith(NPM_ALIAS_PREFIX)) {
    return aliasVersion(specifier) ?? manifestVersion;
  }
  if (!GIT_SPECIFIER.test(specifier)) {
    return manifestVersion;
  }
  const separator = specifier.lastIndexOf("#");
  if (separator === -1) {
    return manifestVersion;
  }
  const ref = specifier.slice(separator + 1).trim();
  return ref === "" ? manifestVersion : `${ref} (${sourceLabel(specifier)})`;
}
