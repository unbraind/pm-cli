/**
 * @module core/session/session-state
 *
 * Maintains lightweight agent session state for contextual workflows.
 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../fs/fs-utils.js";
import { getRuntimePath } from "../store/paths.js";

/**
 * Session-local, gitignored state stored under `.agents/pm/runtime/session.json`.
 *
 * This is intentionally NOT the git-tracked settings.json: it holds ephemeral
 * per-checkout context (currently the "focused" parent item used as a default
 * --parent for `pm create`). Missing or corrupt state is treated as empty so a
 * stale or hand-edited file never blocks a command.
 */
export interface SessionState {
  /** Value that configures or reports focused item for this contract. */
  focused_item?: string;
  /** Privacy-safe semantic work context partitioned by agent invocation. */
  semantic_attribution?: Record<string, AgentSemanticAttribution>;
}

/** Bounded inferred work context consumed by mutation provenance. */
export interface AgentSemanticAttribution {
  /** Controlled role inferred from the current work lifecycle. */
  role: "implementer" | "planner" | "release-operator";
  /** Stable item or workset identity, never prompt text. */
  topic: string;
  /** Confidence attached to the inferred observation. */
  confidence: "high" | "medium";
  /** Versioned inference rule understood by history consumers. */
  rule_version: "v2";
  /** Bounded item and lineage references supporting the inference. */
  evidence: string[];
  /** Claimed items currently contributing to the workset. */
  active_item_ids: string[];
  /** Explicitly focused item when focus takes precedence over claims. */
  focused_item_id?: string;
}

const SESSION_FILENAME = "session.json";

function isBoundedNonEmptyString(value: unknown, maximum: number): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function parseSemanticAttribution(
  value: unknown,
): AgentSemanticAttribution | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const validRole = ["implementer", "planner", "release-operator"].includes(
    String(record.role),
  );
  const validConfidence = ["high", "medium"].includes(
    String(record.confidence),
  );
  const validTopic = isBoundedNonEmptyString(record.topic, 256);
  const validEvidence =
    Array.isArray(record.evidence) &&
    record.evidence.length <= 32 &&
    record.evidence.every(
      (entry) => typeof entry === "string" && entry.length <= 128,
    );
  const validActiveItems =
    Array.isArray(record.active_item_ids) &&
    record.active_item_ids.length <= 64 &&
    record.active_item_ids.every((entry) =>
      isBoundedNonEmptyString(entry, 128),
    );
  const validFocus =
    record.focused_item_id === undefined ||
    isBoundedNonEmptyString(record.focused_item_id, 128);
  if (
    ![
      validRole,
      validConfidence,
      validTopic,
      validEvidence,
      validActiveItems,
      validFocus,
      record.rule_version === "v2",
    ].every(Boolean)
  ) {
    return undefined;
  }
  return record as unknown as AgentSemanticAttribution;
}

function parseSemanticAttributionMap(
  value: unknown,
): Record<string, AgentSemanticAttribution> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .slice(0, 128)
    .flatMap(([key, attribution]) => {
      const parsed = parseSemanticAttribution(attribution);
      return parsed && key.length <= 128 ? [[key, parsed] as const] : [];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Implements get session state path for the public runtime surface of this module. */
export function getSessionStatePath(pmRoot: string): string {
  return path.join(getRuntimePath(pmRoot), SESSION_FILENAME);
}

/** Implements read session state for the public runtime surface of this module. */
export async function readSessionState(pmRoot: string): Promise<SessionState> {
  try {
    const raw = await fs.readFile(getSessionStatePath(pmRoot), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const focused = record.focused_item;
    const semanticAttribution = parseSemanticAttributionMap(
      record.semantic_attribution,
    );
    if (typeof focused === "string" && focused.trim().length > 0) {
      return {
        focused_item: focused,
        ...(semanticAttribution
          ? { semantic_attribution: semanticAttribution }
          : {}),
      };
    }
    return semanticAttribution
      ? { semantic_attribution: semanticAttribution }
      : {};
  } catch {
    return {};
  }
}

async function writeSessionState(
  pmRoot: string,
  state: SessionState,
): Promise<void> {
  const target = getSessionStatePath(pmRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, JSON.stringify(state));
}

/** Derive a non-secret state key from a claim principal. */
export function semanticAttributionKey(principal: string): string {
  const instance = /#([a-f0-9]{24})$/u.exec(principal.trim())?.[1];
  return (
    instance ??
    `author-${createHash("sha256").update(principal).digest("hex").slice(0, 24)}`
  );
}

function normalizedEvidence(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, 32)
    .map((value) => value.slice(0, 128));
}

function worksetTopic(activeItemIds: readonly string[]): string {
  const ids = [...new Set(activeItemIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (ids.length === 1) return ids[0]!;
  const complete = `workset:${ids.join("+")}`;
  if (complete.length <= 256) return complete;
  const visible = ids.join("+").slice(0, 230);
  return `workset:${visible}+${createHash("sha256").update(ids.join("\0")).digest("hex").slice(0, 12)}`;
}

async function updateSemanticAttribution(
  pmRoot: string,
  key: string,
  mutate: (
    current: AgentSemanticAttribution | undefined,
  ) => AgentSemanticAttribution | undefined,
): Promise<void> {
  const state = await readSessionState(pmRoot);
  const attributions = { ...state.semantic_attribution };
  const next = mutate(attributions[key]);
  if (next === undefined) delete attributions[key];
  else attributions[key] = next;
  const nextState: SessionState = { ...state };
  if (Object.keys(attributions).length === 0) {
    delete nextState.semantic_attribution;
  } else {
    nextState.semantic_attribution = attributions;
  }
  await writeSessionState(pmRoot, nextState);
}

/** Record a successful claim as incremental semantic session evidence. */
export async function recordClaimedWorkAttribution(params: {
  pmRoot: string;
  principal: string;
  itemId: string;
  lineageIds?: readonly string[];
}): Promise<void> {
  const key = semanticAttributionKey(params.principal);
  await updateSemanticAttribution(params.pmRoot, key, (current) => {
    const activeItemIds = [
      ...new Set([...(current?.active_item_ids ?? []), params.itemId]),
    ]
      .slice(-64)
      .sort((left, right) => left.localeCompare(right));
    const focusedItemId = current?.focused_item_id;
    return {
      role: "implementer",
      topic: focusedItemId ?? worksetTopic(activeItemIds),
      confidence: focusedItemId ? "high" : "medium",
      rule_version: "v2",
      evidence: normalizedEvidence([
        ...activeItemIds.map((id) => `claim:${id}`),
        ...(focusedItemId ? [`focus:${focusedItemId}`] : []),
        ...(params.lineageIds ?? []).map((id) => `lineage:${id}`),
      ]),
      active_item_ids: activeItemIds,
      ...(focusedItemId ? { focused_item_id: focusedItemId } : {}),
    };
  });
}

/** Remove a released item from incremental semantic session evidence. */
export async function releaseClaimedWorkAttribution(params: {
  pmRoot: string;
  principal: string;
  itemId: string;
}): Promise<void> {
  const key = semanticAttributionKey(params.principal);
  await updateSemanticAttribution(params.pmRoot, key, (current) => {
    if (!current) return undefined;
    const activeItemIds = current.active_item_ids.filter(
      (id) => id !== params.itemId,
    );
    if (activeItemIds.length === 0 && !current.focused_item_id)
      return undefined;
    const focusedItemId = current.focused_item_id;
    return {
      ...current,
      role: "release-operator",
      topic: focusedItemId ?? worksetTopic(activeItemIds),
      confidence: focusedItemId ? "high" : "medium",
      evidence: normalizedEvidence([
        ...activeItemIds.map((id) => `claim:${id}`),
        ...(focusedItemId ? [`focus:${focusedItemId}`] : []),
        `release:${params.itemId}`,
      ]),
      active_item_ids: activeItemIds,
    };
  });
}

/** Set or clear focus as the highest-confidence semantic topic. */
export async function recordFocusedWorkAttribution(params: {
  pmRoot: string;
  principal: string;
  itemId?: string;
  lineageIds?: readonly string[];
}): Promise<void> {
  const key = semanticAttributionKey(params.principal);
  await updateSemanticAttribution(params.pmRoot, key, (current) => {
    const activeItemIds = current?.active_item_ids ?? [];
    if (!params.itemId && activeItemIds.length === 0) return undefined;
    const focusedItemId = params.itemId;
    return {
      role: focusedItemId ? "planner" : current!.role,
      topic: focusedItemId ?? worksetTopic(activeItemIds),
      confidence: focusedItemId ? "high" : "medium",
      rule_version: "v2",
      evidence: normalizedEvidence([
        ...activeItemIds.map((id) => `claim:${id}`),
        ...(focusedItemId ? [`focus:${focusedItemId}`] : []),
        ...(params.lineageIds ?? []).map((id) => `lineage:${id}`),
      ]),
      active_item_ids: activeItemIds,
      ...(focusedItemId ? { focused_item_id: focusedItemId } : {}),
    };
  });
}

function resolveAttributionRoot(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const configured = env.PM_PATH?.trim();
  if (configured) {
    const resolved = path.resolve(cwd, configured);
    if (existsSync(path.join(resolved, "settings.json"))) return resolved;
    const nested = path.join(resolved, ".agents", "pm");
    if (existsSync(path.join(nested, "settings.json"))) return nested;
  }
  let cursor = path.resolve(cwd);
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = path.join(cursor, ".agents", "pm");
    if (existsSync(path.join(candidate, "settings.json"))) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

/** Read one privacy-bounded inferred attribution without making mutations fail. */
export function readAgentSemanticAttributionSync(params: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  key: string | undefined;
}): AgentSemanticAttribution | undefined {
  if (!params.key) return undefined;
  const pmRoot = resolveAttributionRoot(params.cwd, params.env);
  if (!pmRoot) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(getSessionStatePath(pmRoot), "utf8"),
    ) as SessionState;
    return parseSemanticAttribution(parsed.semantic_attribution?.[params.key]);
  } catch {
    return undefined;
  }
}

/** Implements get focused item for the public runtime surface of this module. */
export async function getFocusedItem(
  pmRoot: string,
): Promise<string | undefined> {
  const state = await readSessionState(pmRoot);
  return state.focused_item;
}

/** Implements set focused item for the public runtime surface of this module. */
export async function setFocusedItem(
  pmRoot: string,
  id: string,
): Promise<void> {
  const state = await readSessionState(pmRoot);
  await writeSessionState(pmRoot, { ...state, focused_item: id });
}

/** Implements clear focused item for the public runtime surface of this module. */
export async function clearFocusedItem(pmRoot: string): Promise<void> {
  const state = await readSessionState(pmRoot);
  const next: SessionState = { ...state };
  delete next.focused_item;
  await writeSessionState(pmRoot, next);
}
