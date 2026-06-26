/**
 * Remote-reference detection for linked artifacts (`pm files` / `pm docs`
 * `path` values).
 *
 * A linked artifact path is normally a workspace-relative or absolute local
 * filesystem path, but `pm docs --add` legitimately records *remote*
 * references too — most commonly an `https://` URL to a pull request, issue, or
 * external design doc. Such references are not local files, so they must never
 * be:
 * - probed with `fs.stat` for existence (the resolved path is meaningless),
 * - classified as `moved`/`deleted` by the stale-path classifier,
 * - counted among `missing_linked_paths` in `pm validate --check-files`, or
 * - pruned by `pm validate --prune-missing` — which would silently destroy an
 *   intentionally-recorded reference (project management = context management).
 *
 * Pure module: no filesystem or network access — callers pass the stored path
 * string and branch on the boolean result.
 */

/**
 * Matches an RFC 3986 URI that carries an authority component
 * (`scheme://…`) — e.g. `https://`, `http://`, `ftp://`, `ssh://`, `file://`.
 *
 * The scheme is required to be at least two characters so a Windows drive
 * prefix (`C:/…`, which is a single letter followed by a single slash and never
 * `://`) can never be mistaken for a remote reference. A relative or absolute
 * POSIX path (`src/api.ts`, `/dev/null`) and a UNC path (`//server/share`) all
 * lack the `scheme://` shape and are correctly treated as local.
 */
const REMOTE_ARTIFACT_REFERENCE_PATTERN = /^[a-z][a-z0-9+.-]+:\/\//i;

/**
 * Return `true` when a linked-artifact path is a remote reference (a URL with a
 * `scheme://` authority) rather than a local filesystem path. Whitespace is
 * trimmed before matching so a stored `"  https://…"` is still recognized.
 */
export function isRemoteLinkedArtifactReference(path: string): boolean {
  return REMOTE_ARTIFACT_REFERENCE_PATTERN.test(path.trim());
}
