/**
 * @module core/extensions/version-compat
 *
 * Single source of truth for extension-manifest version-bound compatibility.
 *
 * An extension manifest may declare an inclusive `pm_min_version` lower bound and
 * an inclusive `pm_max_version` upper bound. At load time the
 * {@link ../extensions/loader.js | loader} compares them against the running pm
 * CLI version and skips (or warns about) an extension that falls outside the
 * supported window. The comparison and the per-bound status semantics live here
 * so the runtime loader and the author-time SDK helper
 * (`checkExtensionManifestCompatibility`) share one implementation and can never
 * drift — the same "agrees with the loader by construction" guarantee the
 * declarative authoring helpers (`describeExtensionBlueprint`,
 * `deriveExtensionCapabilities`) already provide.
 *
 * The functions here are pure: they take an already-resolved current version
 * (the loader resolves it from `package.json`; the SDK caller supplies a target
 * version) and return structured outcomes. Warning-string formatting and
 * version resolution stay with the loader; finding/message presentation stays
 * with the SDK.
 */
import type { PmMaxVersionExceededMode } from "./extension-types.js";

/** The two inclusive manifest version bounds pm evaluates at load time. */
export type PmVersionBoundKind = "pm_min_version" | "pm_max_version";

/**
 * The outcome of evaluating a single manifest version bound against a pm version.
 *
 * - `absent`: the bound is not declared — nothing to enforce.
 * - `ok`: the bound is declared and satisfied by the current version.
 * - `invalid`: the declared bound is malformed (unparseable, or a range prefix on
 *   `pm_max_version`); the loader treats the extension as incompatible and skips it.
 * - `unchecked`: the bound is well-formed but cannot be compared against the
 *   current version (the current version is unknown or not comparable); the
 *   extension still loads, with an advisory warning.
 * - `unmet`: the current version is older than the inclusive `pm_min_version`
 *   lower bound; the loader skips the extension (only emitted for `pm_min_version`).
 * - `exceeded`: the current version is newer than the inclusive `pm_max_version`
 *   upper bound and the exceeded mode is `block`; the loader skips the extension
 *   (only emitted for `pm_max_version`).
 * - `exceeded_warn`: the current version is newer than `pm_max_version` but the
 *   exceeded mode is `warn`, so the extension loads with an advisory warning
 *   (only emitted for `pm_max_version`).
 */
export type PmVersionBoundStatus =
  | "absent"
  | "ok"
  | "invalid"
  | "unchecked"
  | "unmet"
  | "exceeded"
  | "exceeded_warn";

/**
 * The structured result of evaluating one manifest version bound, consumed by the
 * loader (to format its `extension_pm_*_version_*` warning strings) and the SDK
 * (to build author-time compatibility findings).
 */
export interface PmVersionBoundEvaluation {
  /** Which bound this evaluation describes. */
  kind: PmVersionBoundKind;
  /** The classified outcome of comparing the bound against the current version. */
  status: PmVersionBoundStatus;
  /** Whether the bound permits the extension to load (`false` only for `invalid`/`unmet`/`exceeded`). */
  allowed: boolean;
  /** The declared bound value, verbatim; the empty string when the bound is absent. */
  required: string;
  /** The current version compared against, or `null` when it could not be resolved. */
  current: string | null;
}

/**
 * Parse a comparable release string into numeric segments, or `null` when it is
 * not an interpretable dotted-numeric version.
 *
 * Leniently strips a leading inclusive-minimum `>=` and an optional `v` prefix
 * (so `engines.pm`-style `">=2026.5.31"` and `"v1.2.3"` both parse), then drops
 * any build/pre-release suffix and keeps the leading dotted-numeric release.
 */
export function parseComparableVersion(value: string): number[] | null {
  const normalized = value.trim().replace(/^>=\s*/, "").replace(/^v/i, "");
  const release = normalized.split(/[+-]/, 1)[0];
  if (!/^\d+(?:[.-]\d+)*$/.test(release)) {
    return null;
  }
  return release.split(/[.-]/).map((part) => Number(part));
}

/**
 * Compare two comparable version strings segment by segment.
 *
 * Returns `1` when `currentVersion` is greater, `-1` when it is smaller, `0` when
 * equal, and `null` when either side is not an interpretable version (so callers
 * can classify the comparison as `unchecked`). Missing trailing segments are
 * treated as `0`, so `1.2` and `1.2.0` compare equal.
 */
export function compareComparableVersions(currentVersion: string, otherVersion: string): number | null {
  const currentParts = parseComparableVersion(currentVersion);
  const otherParts = parseComparableVersion(otherVersion);
  if (!currentParts || !otherParts) {
    return null;
  }
  const width = Math.max(currentParts.length, otherParts.length);
  for (let index = 0; index < width; index += 1) {
    const current = currentParts[index] ?? 0;
    const other = otherParts[index] ?? 0;
    if (current > other) {
      return 1;
    }
    if (current < other) {
      return -1;
    }
  }
  return 0;
}

/**
 * Evaluate a manifest `pm_min_version` inclusive lower bound against the current
 * pm version.
 *
 * An absent or blank bound is `absent`; an unparseable bound is `invalid`; an
 * unknown or incomparable current version is `unchecked`; a current version below
 * the bound is `unmet`; otherwise the bound is satisfied (`ok`). `currentVersion`
 * is `null` when the loader could not resolve the running CLI version.
 */
export function evaluatePmMinVersionBound(
  required: string | undefined,
  currentVersion: string | null,
): PmVersionBoundEvaluation {
  const declared = typeof required === "string" ? required : "";
  if (declared.trim().length === 0) {
    return { kind: "pm_min_version", status: "absent", allowed: true, required: declared, current: currentVersion };
  }
  if (!parseComparableVersion(declared)) {
    return { kind: "pm_min_version", status: "invalid", allowed: false, required: declared, current: currentVersion };
  }
  if (currentVersion === null) {
    return { kind: "pm_min_version", status: "unchecked", allowed: true, required: declared, current: null };
  }
  const comparison = compareComparableVersions(currentVersion, declared);
  if (comparison === null) {
    return { kind: "pm_min_version", status: "unchecked", allowed: true, required: declared, current: currentVersion };
  }
  if (comparison < 0) {
    return { kind: "pm_min_version", status: "unmet", allowed: false, required: declared, current: currentVersion };
  }
  return { kind: "pm_min_version", status: "ok", allowed: true, required: declared, current: currentVersion };
}

/**
 * Evaluate a manifest `pm_max_version` inclusive upper bound against the current
 * pm version.
 *
 * An absent or blank bound is `absent`. The upper bound must be an exact version:
 * a range prefix (`<`/`>`/`=`/`~`/`^`) is rejected as `invalid`, because
 * {@link parseComparableVersion} leniently strips a leading `>=` for
 * `engines.pm` min-version compatibility and would otherwise turn a range-like
 * `">=2026.6.1"` into an inclusive max and wrongly block newer CLIs. An
 * unparseable bound is `invalid`; an unknown or incomparable current version is
 * `unchecked`; a current version above the bound is `exceeded` (or
 * `exceeded_warn` when `exceededMode` is `warn`, so the extension still loads
 * during a controlled upgrade window); otherwise the bound is satisfied (`ok`).
 */
export function evaluatePmMaxVersionBound(
  required: string | undefined,
  currentVersion: string | null,
  exceededMode: PmMaxVersionExceededMode,
): PmVersionBoundEvaluation {
  const declared = typeof required === "string" ? required : "";
  if (declared.trim().length === 0) {
    return { kind: "pm_max_version", status: "absent", allowed: true, required: declared, current: currentVersion };
  }
  if (/^[<>=~^]/.test(declared.trim()) || !parseComparableVersion(declared)) {
    return { kind: "pm_max_version", status: "invalid", allowed: false, required: declared, current: currentVersion };
  }
  if (currentVersion === null) {
    return { kind: "pm_max_version", status: "unchecked", allowed: true, required: declared, current: null };
  }
  const comparison = compareComparableVersions(currentVersion, declared);
  if (comparison === null) {
    return { kind: "pm_max_version", status: "unchecked", allowed: true, required: declared, current: currentVersion };
  }
  if (comparison > 0) {
    if (exceededMode === "warn") {
      return {
        kind: "pm_max_version",
        status: "exceeded_warn",
        allowed: true,
        required: declared,
        current: currentVersion,
      };
    }
    return { kind: "pm_max_version", status: "exceeded", allowed: false, required: declared, current: currentVersion };
  }
  return { kind: "pm_max_version", status: "ok", allowed: true, required: declared, current: currentVersion };
}
