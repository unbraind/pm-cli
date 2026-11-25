/**
 * @module sdk/extension/npm-spec
 *
 * Whether an npm install source names a registry package or a local or remote
 * artifact (a path, a tarball, a `file:` spec, a git or URL spec). Upgrades
 * reinstall such an artifact as it is, so a registry release is never an update
 * for it (pm-gh1778). Specs are classified with npm's own parser.
 */
import path from "node:path";
import npa from "npm-package-arg";
import semver from "semver";
import type { ManagedExtensionSource } from "./managed-state.js";

/** npm-package-arg types that resolve through the registry. */
const REGISTRY_SPEC_TYPES = new Set(["tag", "version", "range"]);

/** npm's classification of a raw spec, or undefined when it does not parse. */
function parseNpmSpecType(spec: string): string | undefined {
  try {
    const parsed = npa(spec);
    const aliased = (parsed as { subSpec?: { type?: string } }).subSpec;
    return parsed.type === "alias" ? aliased?.type : parsed.type;
  } catch {
    return undefined;
  }
}

/** Whether a raw npm spec names a local path, tarball or `file:` artifact rather than a registry package. */
export function isLocalNpmSpec(spec: string): boolean {
  if (path.isAbsolute(spec) || spec.startsWith(".") || spec.startsWith("file:")) return true;
  const type = parseNpmSpecType(spec);
  // npm's own registry verdict wins (`@scope/plugin.tgz` is a registry package name, Codex review round 6).
  if (type !== undefined && REGISTRY_SPEC_TYPES.has(type)) return false;
  // An archive path such as `artifacts/pkg.tgz` is local even without a leading `./`, as the installer reads it.
  return type === "file" || type === "directory" || /\.(?:tgz|tar\.gz|tar)$/iu.test(spec);
}

/** Whether a managed source installs from the npm registry, so a newer registry release can replace it. */
export function isRegistryNpmSource(source: ManagedExtensionSource): boolean {
  if (source.kind !== "npm") return false;
  const spec = source.input.startsWith("npm:") ? source.input.slice("npm:".length).trim() : source.input.trim();
  const type = parseNpmSpecType(spec);
  return type !== undefined && REGISTRY_SPEC_TYPES.has(type);
}

/**
 * Whether a registry `latest` is an update for an installed version: newer under
 * SemVer precedence (a release is newer than its own prerelease; an older
 * `latest` is no update, because installing it would downgrade). Versions that
 * are not valid SemVer count as an update whenever they differ.
 */
export function isNewerRegistryVersion(latest: string, installed: string): boolean {
  if (semver.valid(latest) === null || semver.valid(installed) === null) return latest !== installed;
  return semver.gt(latest, installed);
}
