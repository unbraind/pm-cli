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
 * select another installation, become an option, or lose its quoting; a project
 * command names the absolute tracker this read served, so it runs against the
 * same tracker from any directory, and no hint inherits `--no-extensions`.
 */
export function buildExtensionUpgradeHints(updatable: readonly ExtensionUpgradeHintRow[], pmRoot: string): string[] {
  return (["project", "global"] as const)
    .filter((scope) => updatable.some((entry) => entry.scope === scope))
    .map((scope) => renderPmCommand([
      ...(scope === "project" ? ["--pm-path", renderTrimSafeTrackerPath(pmRoot)] : []),
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
