# Progressive Tool Discovery

Tracker: [pm-3g3f8z](../.agents/pm/features/pm-3g3f8z.toon).

`pm` exposes a public SDK discovery engine and an opt-in MCP extension for large tool catalogs. The design keeps the full legacy-compatible catalog available while allowing capable clients to attach only a small entry surface and expand it by intent.

## Negotiation and entry catalog

`server/discover` advertises the namespaced `dev.unbrained.pm/progressive-tool-discovery` extension. A client opts in by returning that extension in the request-local MCP capabilities on every modern request. Negotiated `tools/list` responses contain the stable entry catalog:

- `pm_discover` for bounded capability expansion;
- `pm_next` and `pm_context` for action and workspace orientation;
- `pm_search` and `pm_get` for targeted retrieval.

Clients that do not negotiate the extension receive the complete profile-selected tool list. Legacy initialize-era clients are unchanged.

## Public SDK contract

`discoverPmTools()` accepts an authorization-filtered candidate catalog plus query, family, tier, limit, cursor, schema projection, profile, and output-budget options. It returns:

- deterministic score-then-name ordering;
- lexical, semantic, graph, permission, freshness, and usage scores with public weights and source provenance;
- a cursor bound to query, filters, schemas, authorization-filtered catalog, and ranking inputs;
- exact estimated token cost and a fail-closed `within_budget` verdict;
- explicit schema, row-limit, and token-budget omission receipts with recovery;
- a private cache key, 30-second TTL, and named invalidation events.

Hosts may supply normalized semantic, graph, freshness, and usage signals. Missing host values use documented deterministic fallbacks, and the result identifies every signal source; the formula never changes implicitly.

## Canonical tool results

Negotiated clients treat `structuredContent.result` as the single canonical model-facing application result. The text content becomes a stable pointer instead of a second JSON serialization. Errors use the same rule through `structuredContent`.

Unnegotiated and legacy clients retain the prior duplicated JSON text plus structured result. That compatibility behavior is isolated at the MCP adapter boundary; domain operations and SDK results do not branch on transport generation.

## Scale and change safety

The discovery quality gate exercises selection, deterministic pagination, stale-cursor refusal, permission filtering, schema recovery, and token ceilings at 100, 1,000, and 10,000 candidate tools. Contract snapshots cover the tool schema, and modern MCP integration tests prove both negotiated and compatibility modes.

Any tool-definition, workspace-extension, profile, authorization, or ranking-signal change invalidates prior cursors and cache entries. Clients restart discovery without a cursor after that explicit stale-cursor refusal.
