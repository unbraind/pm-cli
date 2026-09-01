/**
 * @module sdk/mcp/discovery
 *
 * Provides the deterministic, token-bounded progressive tool discovery
 * contract shared by MCP servers, embedded hosts, and agent integrations.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  PM_COMMAND_CAPABILITY_CONTRACTS,
  PM_MCP_TOOL_COMMAND_CONTRACTS,
  resolvePmCommandCapabilityFamily,
  resolvePmCommandVisibilityTier,
  type PmCommandCapabilityFamily,
  type PmCommandVisibilityTier,
  type PmMcpToolProfile,
} from "../agent-capability-contracts.js";
import { PmCliError } from "../runtime-primitives.js";

/** Namespaced MCP extension that opts a client into progressive tool discovery. */
export const PM_MCP_PROGRESSIVE_DISCOVERY_EXTENSION =
  "dev.unbrained.pm/progressive-tool-discovery";

/** Versioned server capability advertised for progressive tool discovery. */
export const PM_MCP_PROGRESSIVE_DISCOVERY_SERVER_CAPABILITY = Object.freeze({
  version: 1,
  discoveryTool: "pm_discover",
  canonicalResult: "structuredContent.result",
  compatibilityText: "pointer",
});

/** Small stable tool catalog returned to clients that negotiate the extension. */
export const PM_MCP_ENTRY_TOOL_NAMES: readonly string[] = Object.freeze([
  "pm_discover",
  "pm_next",
  "pm_context",
  "pm_search",
  "pm_get",
]);

/** Ranking signals composed by the public discovery contract. */
export type PmToolDiscoverySignalName =
  | "lexical"
  | "semantic"
  | "graph"
  | "permission"
  | "freshness"
  | "usage";

/** Optional host-owned signals supplied for one tool. */
export interface PmToolDiscoverySignalInput {
  /** Semantic relevance normalized to the inclusive range zero through one. */
  semantic?: number;
  /** Graph proximity normalized to the inclusive range zero through one. */
  graph?: number;
  /** Definition freshness normalized to the inclusive range zero through one. */
  freshness?: number;
  /** Historical selection usefulness normalized to the inclusive range zero through one. */
  usage?: number;
}

/** One tool definition accepted by the SDK discovery engine. */
export interface PmToolDiscoveryCandidate {
  /** Stable callable tool name. */
  name: string;
  /** Agent-facing tool description. */
  description: string;
  /** JSON Schema supplied when callers request schema expansion. */
  inputSchema: Record<string, unknown>;
  /** Whether the current caller is authorized to invoke the tool. */
  authorized?: boolean;
  /** Optional host-owned ranking signals. */
  signals?: PmToolDiscoverySignalInput;
}

/** Options controlling one progressive discovery page. */
export interface PmToolDiscoveryOptions {
  /** Free-text capability intent. Empty text lists by deterministic policy order. */
  query?: string;
  /** Restrict results to one stable capability family. */
  family?: PmCommandCapabilityFamily;
  /** Restrict results to tools visible at or below this tier. */
  tier?: Exclude<PmCommandVisibilityTier, "internal">;
  /** Maximum result rows, from one through one hundred. */
  limit?: number;
  /** Opaque continuation cursor from an equivalent discovery request. */
  cursor?: string;
  /** Include complete input schemas instead of the default compact projection. */
  includeSchema?: boolean;
  /** Estimated-token ceiling, or unbounded for the complete selected page. */
  outputBudget?: number | "unbounded";
  /** MCP profile that produced the authorized candidate catalog. */
  profile?: PmMcpToolProfile;
  /** Host-owned HMAC key of at least 32 bytes for restart-stable cursors. */
  cursorIntegrityKey?: Uint8Array;
}

/** Applied score for one signal with explicit provenance. */
export interface PmToolDiscoveryAppliedSignal {
  /** Normalized signal value. */
  value: number;
  /** Public policy weight. */
  weight: number;
  /** Whether the signal was computed or supplied rather than defaulted. */
  available: boolean;
  /** Transparent source of the normalized value. */
  source: "computed" | "host" | "authorization" | "unavailable";
}

/** One ranked discovery result. */
export interface PmToolDiscoveryResultRow {
  /** Stable callable tool name. */
  name: string;
  /** Agent-facing description. */
  description: string;
  /** Canonical CLI command backing the tool. */
  command: string;
  /** Minimum visibility tier inherited from the command contract. */
  tier: PmCommandVisibilityTier;
  /** Stable capability family inherited from the command contract. */
  family: PmCommandCapabilityFamily;
  /** Weighted aggregate score used for ordering. */
  score: number;
  /** Complete per-signal score explanation. */
  signals: Readonly<
    Record<PmToolDiscoverySignalName, PmToolDiscoveryAppliedSignal>
  >;
  /** Complete JSON Schema when explicitly requested. */
  input_schema?: Record<string, unknown>;
}

/** Explicit receipt for information omitted from a discovery page. */
export interface PmToolDiscoveryOmissionReceipt {
  /** Whether any result rows or schemas were omitted. */
  has_omissions: boolean;
  /** Stable omitted field groups. */
  omitted: Array<{
    name: "input_schema" | "tools";
    reason: "compact_projection" | "limit" | "token_budget";
    restore_with: string;
  }>;
}

/** Deterministic progressive tool discovery response. */
export interface PmToolDiscoveryResult {
  /** Stable result discriminator for model and host routing. */
  result_type: "pm_tool_discovery";
  /** Public contract revision. */
  contract_version: 1;
  /** Normalized query used by ranking and cursor binding. */
  query: string;
  /** MCP profile that produced the candidate catalog. */
  profile: PmMcpToolProfile;
  /** Ranked page of authorized tools. */
  tools: PmToolDiscoveryResultRow[];
  /** Total authorized rows after filters and before pagination. */
  total: number;
  /** Rows returned on this page. */
  returned: number;
  /** Whether a later ranked row remains. */
  has_more: boolean;
  /** Opaque continuation cursor bound to query, filters, and catalog. */
  next_cursor?: string;
  /** Exact estimated serialized result cost. */
  token_cost: {
    estimated_tokens: number;
    budget: number | "unbounded";
    within_budget: boolean;
  };
  /** Public ranking formula and weights. */
  ranking_policy: {
    version: 1;
    formula: "weighted_sum_then_name";
    weights: Readonly<Record<PmToolDiscoverySignalName, number>>;
  };
  /** Cache identity and invalidation contract for deterministic pages. */
  cache: {
    key: string;
    ttl_ms: number;
    scope: "private";
    invalidates_on: readonly string[];
  };
  /** Explicit recovery for compacted fields and rows. */
  omission_receipt: PmToolDiscoveryOmissionReceipt;
}

const DISCOVERY_WEIGHTS: Readonly<Record<PmToolDiscoverySignalName, number>> =
  Object.freeze({
    lexical: 0.4,
    semantic: 0.2,
    graph: 0.1,
    permission: 0.15,
    freshness: 0.05,
    usage: 0.1,
  });

const DISCOVERY_CACHE_INVALIDATIONS = Object.freeze([
  "profile_changed",
  "tool_contract_changed",
  "workspace_extension_changed",
  "authorization_changed",
  "ranking_signal_changed",
  "cursor_integrity_key_rotated",
]);

const TIER_RANK: Readonly<Record<PmCommandVisibilityTier, number>> = {
  core: 0,
  standard: 1,
  full: 2,
  internal: 3,
};

const SELECTABLE_TIERS: readonly string[] = Object.freeze([
  "core",
  "standard",
  "full",
]);

const MCP_TOOL_PROFILES: ReadonlySet<string> = new Set([
  "core",
  "standard",
  "full",
  "custom",
]);

const CAPABILITY_FAMILIES: ReadonlySet<string> = new Set(
  PM_COMMAND_CAPABILITY_CONTRACTS.map(({ family }) => family),
);

interface PmToolDiscoveryCursor {
  version: 1;
  offset: number;
  signature: string;
}

const PROCESS_CURSOR_INTEGRITY_KEY = randomBytes(32);

/** Validate a discovery string with the Unicode code-point semantics used by JSON Schema. */
function boundedDiscoveryString(
  value: unknown,
  field: "query" | "cursor",
): string {
  if (typeof value !== "string") {
    throw new PmCliError(
      `pm tool discovery ${field} must be a string of at most 4096 Unicode characters.`,
      64,
    );
  }
  const iterator = value[Symbol.iterator]();
  let count = 0;
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    count += 1;
    if (count > 4_096) {
      throw new PmCliError(
        `pm tool discovery ${field} must be a string of at most 4096 Unicode characters.`,
        64,
      );
    }
  }
  return value;
}

function discoveryLimit(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new PmCliError(
      "pm tool discovery limit must be from 1 through 100.",
      64,
    );
  }
  return Number(value);
}

function discoveryOutputBudget(value: unknown): number | "unbounded" {
  if (
    value !== "unbounded" &&
    (!Number.isInteger(value) || Number(value) < 128)
  ) {
    throw new PmCliError(
      "pm tool discovery outputBudget must be unbounded or an integer of at least 128.",
      64,
    );
  }
  return value === "unbounded" ? value : Number(value);
}

function discoveryIncludeSchema(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new PmCliError(
      "pm tool discovery includeSchema must be a boolean.",
      64,
    );
  }
  return value === true;
}

function validateDiscoveryOptionsContainer<Value>(
  value: Value,
): asserts value is Value & object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PmCliError("pm tool discovery options must be an object.", 64);
  }
}

/** Reject malformed candidate catalogs supplied by untyped SDK consumers. */
function validateDiscoveryCandidates(candidates: unknown): void {
  if (!Array.isArray(candidates)) {
    throw new PmCliError("pm tool discovery candidates must be an array.", 64);
  }
  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new PmCliError(
        `pm tool discovery candidate ${index} must be an object.`,
        64,
      );
    }
    if (
      typeof candidate.name !== "string" ||
      candidate.name.trim().length === 0
    ) {
      throw new PmCliError(
        `pm tool discovery candidate ${index} name must be a non-empty string.`,
        64,
      );
    }
    if (
      typeof candidate.description !== "string" ||
      candidate.description.trim().length === 0
    ) {
      throw new PmCliError(
        `pm tool discovery candidate ${index} description must be a non-empty string.`,
        64,
      );
    }
    if (
      candidate.inputSchema === null ||
      typeof candidate.inputSchema !== "object" ||
      Array.isArray(candidate.inputSchema)
    ) {
      throw new PmCliError(
        `pm tool discovery candidate ${index} inputSchema must be an object.`,
        64,
      );
    }
  }
}

/** Parse untrusted adapter input without discarding malformed discovery values. */
export function parsePmToolDiscoveryOptions(
  input: Record<string, unknown>,
): PmToolDiscoveryOptions {
  validateDiscoveryOptionsContainer(input);
  if (
    input.family !== undefined &&
    (typeof input.family !== "string" || !CAPABILITY_FAMILIES.has(input.family))
  ) {
    throw new PmCliError(
      "pm tool discovery family must be a declared capability family.",
      64,
    );
  }
  if (
    input.tier !== undefined &&
    (typeof input.tier !== "string" || !SELECTABLE_TIERS.includes(input.tier))
  ) {
    throw new PmCliError(
      "pm tool discovery tier must be core, standard, or full.",
      64,
    );
  }
  return {
    ...(input.query !== undefined
      ? { query: boundedDiscoveryString(input.query, "query") }
      : {}),
    ...(input.family !== undefined
      ? { family: input.family as PmCommandCapabilityFamily }
      : {}),
    ...(input.tier !== undefined
      ? {
          tier: input.tier as Exclude<PmCommandVisibilityTier, "internal">,
        }
      : {}),
    ...(input.limit !== undefined
      ? { limit: discoveryLimit(input.limit) }
      : {}),
    ...(input.cursor !== undefined
      ? { cursor: boundedDiscoveryString(input.cursor, "cursor") }
      : {}),
    ...(input.includeSchema !== undefined
      ? { includeSchema: discoveryIncludeSchema(input.includeSchema) }
      : {}),
    ...(input.outputBudget !== undefined
      ? { outputBudget: discoveryOutputBudget(input.outputBudget) }
      : {}),
  };
}

function normalizedUnitInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizedSearchTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]+/gu) ?? [])].sort();
}

function lexicalRelevance(query: string, text: string): number {
  const queryTokens = normalizedSearchTokens(query);
  if (queryTokens.length === 0) return 0;
  const targetTokens = new Set(normalizedSearchTokens(text));
  const matched = queryTokens.filter((token) => targetTokens.has(token)).length;
  const exactBonus = text.toLowerCase().includes(query.toLowerCase())
    ? 0.25
    : 0;
  return Math.min(1, matched / queryTokens.length + exactBonus);
}

function semanticRelevance(query: string, text: string): number {
  const queryTokens = normalizedSearchTokens(query);
  if (queryTokens.length === 0) return 0;
  const target = text.toLowerCase();
  const targetTokens = normalizedSearchTokens(text);
  const related = queryTokens.filter((queryToken) =>
    targetTokens.some(
      (targetToken) =>
        targetToken.startsWith(queryToken) ||
        queryToken.startsWith(targetToken),
    ),
  ).length;
  const phraseBonus = target.includes(query.toLowerCase()) ? 0.2 : 0;
  return Math.min(1, related / queryTokens.length + phraseBonus);
}

function hashDiscoveryValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function cursorSignature(
  fingerprint: string,
  offset: number,
  integrityKey: Uint8Array,
): string {
  return createHmac("sha256", integrityKey)
    .update(JSON.stringify({ version: 1, fingerprint, offset }))
    .digest("base64url");
}

function encodeDiscoveryCursor(
  fingerprint: string,
  offset: number,
  integrityKey: Uint8Array,
): string {
  const cursor: PmToolDiscoveryCursor = {
    version: 1,
    offset,
    signature: cursorSignature(fingerprint, offset, integrityKey),
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeDiscoveryCursor(
  value: string | undefined,
  fingerprint: string,
  total: number,
  integrityKey: Uint8Array,
): number {
  if (value === undefined) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<PmToolDiscoveryCursor>;
    if (
      decoded.version !== 1 ||
      !Number.isInteger(decoded.offset) ||
      (decoded.offset ?? -1) < 0 ||
      Number(decoded.offset) > total ||
      typeof decoded.signature !== "string"
    ) {
      throw new Error("cursor fields do not match the request");
    }
    const expectedSignature = Buffer.from(
      cursorSignature(fingerprint, decoded.offset as number, integrityKey),
      "base64url",
    );
    const suppliedSignature = Buffer.from(decoded.signature, "base64url");
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error("cursor signature does not match the request");
    }
    return decoded.offset as number;
  } catch (error: unknown) {
    throw new PmCliError(
      "Invalid or stale pm tool discovery cursor; restart discovery without cursor.",
      64,
      { reason: String(error) },
    );
  }
}

function appliedSignal(
  value: number,
  weight: number,
  source: PmToolDiscoveryAppliedSignal["source"],
): PmToolDiscoveryAppliedSignal {
  return {
    value: normalizedUnitInterval(value),
    weight,
    available: source !== "unavailable",
    source,
  };
}

function hostOrComputedSignal(
  hostValue: number | undefined,
  computedValue: number,
  weight: number,
): PmToolDiscoveryAppliedSignal {
  return appliedSignal(
    hostValue ?? computedValue,
    weight,
    hostValue === undefined ? "computed" : "host",
  );
}

function buildRankedRow(
  candidate: PmToolDiscoveryCandidate,
  query: string,
  includeSchema: boolean,
): PmToolDiscoveryResultRow {
  const command = Object.hasOwn(PM_MCP_TOOL_COMMAND_CONTRACTS, candidate.name)
    ? PM_MCP_TOOL_COMMAND_CONTRACTS[candidate.name]
    : "help";
  const family = resolvePmCommandCapabilityFamily(command);
  const searchableText = `${candidate.name} ${candidate.description} ${command} ${family}`;
  const lexical = lexicalRelevance(query, searchableText);
  const queryTokens = new Set(normalizedSearchTokens(query));
  const signals: Readonly<
    Record<PmToolDiscoverySignalName, PmToolDiscoveryAppliedSignal>
  > = {
    lexical: appliedSignal(lexical, DISCOVERY_WEIGHTS.lexical, "computed"),
    semantic: hostOrComputedSignal(
      candidate.signals?.semantic,
      semanticRelevance(query, searchableText),
      DISCOVERY_WEIGHTS.semantic,
    ),
    graph: hostOrComputedSignal(
      candidate.signals?.graph,
      queryTokens.has(family) || queryTokens.has(command) ? 1 : 0,
      DISCOVERY_WEIGHTS.graph,
    ),
    permission: appliedSignal(1, DISCOVERY_WEIGHTS.permission, "authorization"),
    freshness: hostOrComputedSignal(
      candidate.signals?.freshness,
      1,
      DISCOVERY_WEIGHTS.freshness,
    ),
    usage: hostOrComputedSignal(
      candidate.signals?.usage,
      PM_MCP_ENTRY_TOOL_NAMES.includes(candidate.name) ? 1 : 0,
      DISCOVERY_WEIGHTS.usage,
    ),
  };
  const score = Object.values(signals).reduce(
    (total, signal) => total + signal.value * signal.weight,
    0,
  );
  return {
    name: candidate.name,
    description: candidate.description,
    command,
    tier: resolvePmCommandVisibilityTier(command),
    family,
    score: Number(score.toFixed(6)),
    signals,
    ...(includeSchema
      ? { input_schema: structuredClone(candidate.inputSchema) }
      : {}),
  };
}

interface ResolvedPmToolDiscoveryRequest {
  query: string;
  includeSchema: boolean;
  limit: number;
  budget: number | "unbounded";
  maximumTier: number;
  profile: PmMcpToolProfile;
}

/** Reject runtime filter values that bypass the public TypeScript unions. */
function validateDiscoveryFilters(options: PmToolDiscoveryOptions): void {
  if (
    options.cursorIntegrityKey !== undefined &&
    (!(options.cursorIntegrityKey instanceof Uint8Array) ||
      options.cursorIntegrityKey.byteLength < 32)
  ) {
    throw new PmCliError(
      "pm tool discovery cursorIntegrityKey must contain at least 32 bytes.",
      64,
    );
  }
  if (
    options.tier !== undefined &&
    (typeof options.tier !== "string" ||
      !SELECTABLE_TIERS.includes(options.tier))
  ) {
    throw new PmCliError(
      "pm tool discovery tier must be core, standard, or full.",
      64,
    );
  }
  if (
    options.family !== undefined &&
    (typeof options.family !== "string" ||
      !CAPABILITY_FAMILIES.has(options.family))
  ) {
    throw new PmCliError(
      "pm tool discovery family must be a declared capability family.",
      64,
    );
  }
  if (
    options.profile !== undefined &&
    (typeof options.profile !== "string" ||
      !MCP_TOOL_PROFILES.has(options.profile))
  ) {
    throw new PmCliError(
      "pm tool discovery profile must be core, standard, full, or custom.",
      64,
    );
  }
}

function resolveDiscoveryRequest(
  options: PmToolDiscoveryOptions,
): ResolvedPmToolDiscoveryRequest {
  const rawQuery = boundedDiscoveryString(
    options.query === undefined ? "" : options.query,
    "query",
  );
  const query = rawQuery.trim().replace(/\s+/gu, " ");
  boundedDiscoveryString(
    options.cursor === undefined ? "" : options.cursor,
    "cursor",
  );
  const limit = discoveryLimit(
    options.limit === undefined ? 10 : options.limit,
  );
  const budget = discoveryOutputBudget(
    options.outputBudget === undefined ? 1_200 : options.outputBudget,
  );
  validateDiscoveryFilters(options);
  return {
    query,
    includeSchema: discoveryIncludeSchema(options.includeSchema),
    limit,
    budget,
    maximumTier: TIER_RANK[options.tier ?? "full"],
    profile: options.profile === undefined ? "core" : options.profile,
  };
}

type PmToolDiscoveryResultWithoutCost = Omit<
  PmToolDiscoveryResult,
  "token_cost"
>;

/**
 * Measure one result exactly while allowing callers to supply pre-serialized
 * array contents, so budget selection stays linear in the returned row bytes.
 */
function estimateDiscoveryResultTokens(
  resultWithoutCost: PmToolDiscoveryResultWithoutCost,
  budget: number | "unbounded",
  serializedToolRowsBytes?: number,
): number {
  const toolRowsBytes =
    serializedToolRowsBytes ??
    resultWithoutCost.tools.reduce(
      (total, row, index) =>
        total +
        (index === 0 ? 0 : 1) +
        Buffer.byteLength(JSON.stringify(row) as string, "utf8"),
      0,
    );
  const emptyToolsResult = { ...resultWithoutCost, tools: [] };
  let estimatedTokens = 0;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({
        ...emptyToolsResult,
        token_cost: {
          estimated_tokens: estimatedTokens,
          budget,
          within_budget: true,
        },
      }),
      "utf8",
    );
    const nextEstimate = Math.ceil((envelopeBytes + toolRowsBytes) / 4);
    if (nextEstimate === estimatedTokens) break;
    estimatedTokens = nextEstimate;
  }
  return estimatedTokens;
}

function rankedDiscoveryRows(
  candidates: readonly PmToolDiscoveryCandidate[],
  options: PmToolDiscoveryOptions,
  request: ResolvedPmToolDiscoveryRequest,
): PmToolDiscoveryResultRow[] {
  return candidates
    .filter((candidate) => candidate.authorized !== false)
    .map((candidate) =>
      buildRankedRow(candidate, request.query, request.includeSchema),
    )
    .filter(
      (row) =>
        row.tier !== "internal" &&
        TIER_RANK[row.tier] <= request.maximumTier &&
        (options.family === undefined || row.family === options.family),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
}

function rowsWithinDiscoveryBudget(
  candidates: readonly PmToolDiscoveryResultRow[],
  budget: number | "unbounded",
  buildResultWithoutCost: (
    selectedCount: number,
  ) => PmToolDiscoveryResultWithoutCost,
): PmToolDiscoveryResultRow[] {
  if (budget === "unbounded") return [...candidates];
  const selected: PmToolDiscoveryResultRow[] = [];
  let serializedToolRowsBytes = 0;
  for (const [index, row] of candidates.entries()) {
    const candidateRowsBytes =
      serializedToolRowsBytes +
      (index === 0 ? 0 : 1) +
      Buffer.byteLength(JSON.stringify(row) as string, "utf8");
    const estimatedTokens = estimateDiscoveryResultTokens(
      buildResultWithoutCost(index + 1),
      budget,
      candidateRowsBytes,
    );
    if (estimatedTokens > budget) break;
    selected.push(row);
    serializedToolRowsBytes = candidateRowsBytes;
  }
  return selected;
}

/**
 * Rank and page an authorized MCP tool catalog under an explicit token budget.
 *
 * Cursors fail closed when the query, filters, schemas, authorization-filtered
 * catalog, or ranking inputs change. Host signals override documented local
 * fallbacks without changing the public formula or hiding signal provenance.
 */
export function discoverPmTools(
  candidates: readonly PmToolDiscoveryCandidate[],
  options: PmToolDiscoveryOptions = {},
): PmToolDiscoveryResult {
  validateDiscoveryCandidates(candidates);
  validateDiscoveryOptionsContainer(options);
  const request = resolveDiscoveryRequest(options);
  const cursorIntegrityKey =
    options.cursorIntegrityKey ?? PROCESS_CURSOR_INTEGRITY_KEY;
  const ranked = rankedDiscoveryRows(candidates, options, request);
  const fingerprint = hashDiscoveryValue({
    query: request.query,
    family: options.family ?? null,
    tier: options.tier ?? "full",
    includeSchema: request.includeSchema,
    profile: request.profile,
    ranked,
  });
  const offset = decodeDiscoveryCursor(
    options.cursor,
    fingerprint,
    ranked.length,
    cursorIntegrityKey,
  );
  const pageCandidates = ranked.slice(offset, offset + request.limit);
  const omitted: PmToolDiscoveryOmissionReceipt["omitted"] = [];
  if (!request.includeSchema) {
    omitted.push({
      name: "input_schema",
      reason: "compact_projection",
      restore_with: "Set includeSchema=true.",
    });
  }
  if (offset + request.limit < ranked.length) {
    omitted.push({
      name: "tools",
      reason: "limit",
      restore_with: "Continue with next_cursor or increase limit.",
    });
  }
  const base = {
    result_type: "pm_tool_discovery" as const,
    contract_version: 1 as const,
    query: request.query,
    profile: request.profile,
    total: ranked.length,
    ranking_policy: {
      version: 1 as const,
      formula: "weighted_sum_then_name" as const,
      weights: DISCOVERY_WEIGHTS,
    },
    cache: {
      key: hashDiscoveryValue({
        fingerprint,
        cursorIntegrityKey: createHash("sha256")
          .update(cursorIntegrityKey)
          .digest("hex"),
        limit: request.limit,
        offset,
        budget: request.budget,
      }),
      ttl_ms: 30_000,
      scope: "private" as const,
      invalidates_on: DISCOVERY_CACHE_INVALIDATIONS,
    },
  };
  const buildResultWithoutCost = (
    selected: readonly PmToolDiscoveryResultRow[],
    selectedCount = selected.length,
  ): PmToolDiscoveryResultWithoutCost => {
    const endOffset = offset + selectedCount;
    const hasMore = endOffset < ranked.length;
    const resultOmissions = [...omitted];
    if (selectedCount < pageCandidates.length) {
      resultOmissions.push({
        name: "tools",
        reason: "token_budget",
        restore_with: "Continue with next_cursor or increase outputBudget.",
      });
    }
    const resultWithoutCost = {
      ...base,
      tools: [...selected],
      returned: selectedCount,
      has_more: hasMore,
      ...(hasMore
        ? {
            next_cursor: encodeDiscoveryCursor(
              fingerprint,
              endOffset,
              cursorIntegrityKey,
            ),
          }
        : {}),
      omission_receipt: {
        has_omissions: resultOmissions.length > 0,
        omitted: resultOmissions,
      },
    };
    return resultWithoutCost;
  };
  const buildResult = (
    selected: readonly PmToolDiscoveryResultRow[],
  ): PmToolDiscoveryResult => {
    const resultWithoutCost = buildResultWithoutCost(selected);
    const estimatedTokens = estimateDiscoveryResultTokens(
      resultWithoutCost,
      request.budget,
    );
    return {
      ...resultWithoutCost,
      token_cost: {
        estimated_tokens: estimatedTokens,
        budget: request.budget,
        within_budget:
          request.budget === "unbounded" || estimatedTokens <= request.budget,
      },
    };
  };
  const selected = rowsWithinDiscoveryBudget(
    pageCandidates,
    request.budget,
    (selectedCount) => buildResultWithoutCost([], selectedCount),
  );
  const result = buildResult(selected);
  if (pageCandidates.length > 0 && selected.length === 0) {
    const oneRowCost = buildResult([pageCandidates[0]]).token_cost
      .estimated_tokens;
    throw new PmCliError(
      `pm tool discovery outputBudget is too small to return a tool; increase it to at least ${oneRowCost}.`,
      64,
      { required: String(oneRowCost) },
    );
  }
  if (
    request.budget !== "unbounded" &&
    result.token_cost.estimated_tokens > request.budget
  ) {
    throw new PmCliError(
      `pm tool discovery outputBudget is too small; at least ${result.token_cost.estimated_tokens} estimated tokens are required for this page.`,
      64,
      { required: String(result.token_cost.estimated_tokens) },
    );
  }
  return result;
}
