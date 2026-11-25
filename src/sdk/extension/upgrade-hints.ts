/**
 * @module sdk/extension/upgrade-hints
 *
 * The `next` hints `pm context` prints for installed packages with a known update
 * (pm-gh1778): one live, scoped `pm package manage` check per scope, naming no
 * package, rendered from argv for the caller's shell.
 */
import path from "node:path";
import { renderPmCommand } from "../command-line.js";

/** The fields of an `extension_health` row the hints read. */
export interface ExtensionUpgradeHintRow {
  /** Storage scope of the copy with a known update. */
  scope?: "project" | "global";
}

/**
 * One live freshness check per scope with a known update: `pm package manage
 * --<scope>`, which re-checks the registry and names the upgrade in its
 * remediation. The hint names no package, so no manifest-controlled name can
 * select another installation, become an option, or lose its quoting; every
 * command names the absolute tracker this read served, so it runs against the
 * same tracker from any directory, and a caller's explicit `--no-extensions` carries over, because the live
 * check runs before manage's activation probe.
 */
export function buildExtensionUpgradeHints(updatable: readonly ExtensionUpgradeHintRow[], pmRoot: string, noExtensions = false): string[] {
  return (["project", "global"] as const)
    .filter((scope) => updatable.some((entry) => entry.scope === scope))
    .map((scope) => renderPmCommand([
      // Both hints name the tracker: manage's activation probe resolves it even for a global check (Codex review round 15).
      "--pm-path", renderTrimSafeTrackerPath(pmRoot),
      // The live check runs before any activation probe, so a caller's explicit suppression carries over (round 14).
      ...(noExtensions ? ["--no-extensions"] : []),
      "package", "manage", `--${scope}`,
    ]));
}

/**
 * The absolute tracker path for a `--pm-path` hint. The path option is trimmed when
 * read, so a directory name ending in whitespace gets a trailing `/.` component that
 * names the same directory and survives the trim (Codex review round 6).
 */
export function renderTrimSafeTrackerPath(pmRoot: string): string {
  const absolute = path.resolve(pmRoot);
  return /\s$/u.test(absolute) ? `${absolute}${path.sep}.` : absolute;
}
