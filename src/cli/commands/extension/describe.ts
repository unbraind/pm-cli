/**
 * @module cli/commands/extension/describe
 *
 * Builds the `pm extension describe` / `pm package describe` payload: a flat,
 * by-name map of every surface each loaded extension registered.
 *
 * The SDK already ships {@link describeExtensionActivation} -- the `describe`
 * (enumerate-all) verb that complements the `assert*` (verify-one) and `run*`
 * (invoke-one) testing helpers -- but until now it was reachable only from a test
 * that hand-built an {@link ExtensionActivationResult}. This module is the thin
 * orchestration that lets an agent at the CLI (or over MCP) ask "what does this
 * installed extension add to my context?" in one call, instead of stitching
 * together `doctor` (errors), `manage` (update metadata), and a manifest read.
 *
 * It is intentionally pure: the caller performs the load+activate cycle (exactly
 * as `explore`/`doctor` already do) and hands the results here, so the same
 * builder is trivially unit-testable against synthetic activations.
 */
import { describeExtensionActivation, type ExtensionActivationSummary } from "../../../core/extensions/activation-summary.js";
import { renderExtensionSurfaceMarkdown } from "../../../core/extensions/activation-summary-markdown.js";
import type { ExtensionActivationResult, ExtensionLayer, ExtensionLoadResult } from "../../../core/extensions/loader.js";
import { normalizeExtensionNameForMatch } from "./shared.js";

/**
 * Runtime state of a described extension. `ok` loaded and activated cleanly,
 * `failed` loaded but threw during `activate`, and `not_loaded` failed to import
 * at all -- the latter two register nothing, so their `surfaces` are empty and
 * the status explains why (rather than implying the extension contributes
 * nothing).
 */
export type ExtensionDescribeActivationStatus = "ok" | "failed" | "not_loaded";

/**
 * One extension's contribution to the workspace: its identity plus the
 * {@link ExtensionActivationSummary} of every surface it registered.
 *
 * `surfaces` is matched by extension *name* (mirroring
 * {@link describeExtensionActivation}'s name filter), so when the same name is
 * loaded in both the project and global layers each entry reflects that name's
 * combined surfaces -- the `layer`/`version` fields still distinguish the
 * physical entries.
 */
export interface ExtensionSurfaceDescription {
  name: string;
  layer: ExtensionLayer;
  version: string;
  activation_status: ExtensionDescribeActivationStatus;
  surfaces: ExtensionActivationSummary;
}

/**
 * Result of {@link buildExtensionDescribeResult}: the per-extension surface maps
 * plus a deduplicated `union` across the described set. `target` echoes the
 * requested name filter (or `null` for the whole workspace) and `total` counts
 * the described entries so callers need not re-measure `extensions`.
 */
export interface ExtensionDescribeResult {
  target: string | null;
  total: number;
  extensions: ExtensionSurfaceDescription[];
  union: ExtensionActivationSummary;
}

/**
 * Compose a collision-free identity key for an extension from its layer and
 * normalized name. The two parts are joined with a colon; the layer prefix is
 * always a colon-free enum value, so distinct (layer, name) pairs never collide
 * even when a name itself contains a colon.
 */
function layerNameKey(layer: ExtensionLayer, name: string): string {
  return `${layer}:${normalizeExtensionNameForMatch(name)}`;
}

/**
 * Summarize, by name, every registration surface the loaded extensions exercised.
 *
 * Walks `loadResult.loaded` (annotating each with `failed` when its layer+name is
 * in `activationResult.failed`) and `loadResult.failed` (as `not_loaded`), sorts
 * the entries by name then layer for deterministic output, and attaches each
 * extension's {@link describeExtensionActivation} summary. When `target` is
 * provided only the case-insensitively matching extensions are described and the
 * `union` is scoped to that name; otherwise every loaded extension contributes.
 * An unmatched `target` yields an empty `extensions` array -- the caller decides
 * whether that is a not-found error.
 */
export function buildExtensionDescribeResult(
  target: string | undefined,
  loadResult: ExtensionLoadResult,
  activationResult: ExtensionActivationResult,
): ExtensionDescribeResult {
  const activationFailedKeys = new Set(activationResult.failed.map((entry) => layerNameKey(entry.layer, entry.name)));
  const candidates: ExtensionSurfaceDescription[] = [
    ...loadResult.loaded.map((entry) => ({
      name: entry.name,
      layer: entry.layer,
      version: entry.version,
      activation_status: activationFailedKeys.has(layerNameKey(entry.layer, entry.name))
        ? ("failed" as const)
        : ("ok" as const),
      surfaces: describeExtensionActivation(activationResult, { extensionName: entry.name }),
    })),
    ...loadResult.failed.map((entry) => ({
      name: entry.name,
      layer: entry.layer,
      version: "unknown",
      activation_status: "not_loaded" as const,
      surfaces: describeExtensionActivation(activationResult, { extensionName: entry.name }),
    })),
  ].sort((left, right) => left.name.localeCompare(right.name) || left.layer.localeCompare(right.layer));

  const normalizedTarget = typeof target === "string" ? normalizeExtensionNameForMatch(target) : null;
  const extensions =
    normalizedTarget === null
      ? candidates
      : candidates.filter((entry) => normalizeExtensionNameForMatch(entry.name) === normalizedTarget);

  return {
    target: typeof target === "string" ? target.trim() : null,
    total: extensions.length,
    extensions,
    union: describeExtensionActivation(activationResult, normalizedTarget === null ? {} : { extensionName: target }),
  };
}

/**
 * Human-readable label for each {@link ExtensionDescribeActivationStatus}, used
 * in the Markdown per-extension heading so a reader sees *why* an entry has no
 * surfaces (activation failed / never loaded) rather than assuming it
 * contributes nothing.
 */
const ACTIVATION_STATUS_LABELS: Record<ExtensionDescribeActivationStatus, string> = {
  ok: "loaded",
  failed: "activation failed",
  not_loaded: "not loaded",
};

/**
 * Render an {@link ExtensionDescribeResult} as a Markdown reference document: a
 * top-level title and scope line, one section per described extension (titled
 * with its identity and activation status), and — only when more than one
 * extension was described — a final union section spanning them all. Each
 * extension and the union are rendered with the shared
 * {@link renderExtensionSurfaceMarkdown} primitive at heading level 2, so the
 * document nests cleanly under the level-1 title.
 *
 * `noun` is the lifecycle vocabulary (`"extension"` or `"package"`) so the prose
 * matches the command the agent invoked. When no extensions match (an unmatched
 * target is already a not-found error upstream, so this is the "nothing loaded"
 * case) the document is the title plus a single explanatory note.
 */
export function renderExtensionDescribeMarkdown(result: ExtensionDescribeResult, noun: string): string {
  const titleNoun = `${noun[0]!.toUpperCase()}${noun.slice(1)}`;
  const lines = [`# ${titleNoun} surface reference`, ""];
  lines.push(result.target === null ? `Scope: all loaded ${noun}s` : `Scope: \`${result.target}\``);
  lines.push(`Described: ${result.total} ${noun}${result.total === 1 ? "" : "s"}`, "");

  if (result.extensions.length === 0) {
    lines.push(`_No ${noun}s are loaded._`, "");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  for (const entry of result.extensions) {
    const title = `${entry.name} (${entry.layer} v${entry.version}, ${ACTIVATION_STATUS_LABELS[entry.activation_status]})`;
    lines.push(renderExtensionSurfaceMarkdown(entry.surfaces, { title, headingLevel: 2 }), "");
  }

  if (result.extensions.length > 1) {
    lines.push(renderExtensionSurfaceMarkdown(result.union, { title: `Union across all described ${noun}s`, headingLevel: 2 }));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
