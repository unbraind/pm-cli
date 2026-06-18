/**
 * Applied-query echo for agent-facing list/search results (pm-rmjy).
 *
 * Narrow MCP tools accept filters nested inside `options: {}`, so an agent has
 * no structured confirmation of which filters were actually applied or which
 * projection mode resolved. `withQuerySummary` attaches a small `query_summary`
 * block ({ filters, projection }) to the result so the feedback loop closes
 * without the agent re-echoing its inputs.
 */

/** Compact echo of filters and projection mode applied to list/search responses. */
export interface QuerySummary {
  filters: Record<string, unknown>;
  projection: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the projection label implied by list/search projection options.
 * Used when the result payload itself carries no projection metadata (the
 * compact summary paths omit it for token efficiency).
 */
export function resolveQueryProjectionLabel(options: Record<string, unknown>): string {
  if (options.brief === true) {
    return "brief";
  }
  if (typeof options.fields === "string" && options.fields.trim().length > 0) {
    return "fields";
  }
  // The MCP boundary coerces fields arrays to CSV, but tolerate array input
  // here too so direct callers get the same projection label.
  if (Array.isArray(options.fields) && options.fields.length > 0) {
    return "fields";
  }
  if (options.compact === true) {
    return "compact";
  }
  return "full";
}

/**
 * Attach a `query_summary` to a list/search result.
 *
 * `brief` is the most specific requested label, so it wins outright (the list
 * command reports brief as projection mode "compact" with narrowed fields).
 * Otherwise the result's own `projection.mode` states the resolved mode for
 * verbose payloads, and the options-derived label covers the compact summary
 * paths that omit projection metadata.
 */
export function withQuerySummary<T extends Record<string, unknown>>(
  result: T,
  options: Record<string, unknown>,
): T & { query_summary: QuerySummary } {
  const requestedLabel = resolveQueryProjectionLabel(options);
  const projection = requestedLabel === "brief"
    ? requestedLabel
    : isRecord(result.projection) && typeof result.projection.mode === "string"
      ? result.projection.mode
      : requestedLabel;
  return {
    ...result,
    query_summary: {
      filters: isRecord(result.filters) ? result.filters : {},
      projection,
    },
  };
}
