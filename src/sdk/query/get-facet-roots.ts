/**
 * @module sdk/query/get-facet-roots
 *
 * Names the derived facets a `pm get` read attaches beside `item`. Kept free
 * of imports so the core renderer can tell which envelope keys an explicit
 * selection requested without loading the get command (pm-fkhdy8).
 */

/** Derived facets an owner attaches beside `item` when a get read selects them. */
export const GET_FACET_ROOTS: ReadonlySet<string> = new Set(["body", "item_hash", "linked", "claim_state", "children", "schedule", "blockers"]);

/** Facets whose members can be selected one at a time, such as `linked.files`. */
export const GET_NESTED_FACET_ROOTS: ReadonlySet<string> = new Set(["linked", "claim_state", "children", "schedule"]);
