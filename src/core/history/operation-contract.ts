/**
 * @module core/history/operation-contract
 * Declares immutable operation identities separately from hooks and JSON Patch verbs.
 */

/** Native item-event vocabulary. New names require an explicit contract change. */
export const PM_ITEM_HISTORY_OPERATIONS = [
  "append",
  "cancel",
  "claim",
  "close",
  "comment_add",
  "comment_edit",
  "comment_delete",
  "create",
  "delete",
  "docs_add",
  "docs_remove",
  "files_add",
  "files_remove",
  "files_discover",
  "history_author_acknowledge",
  "history_compact",
  "history_compact_baseline",
  "history_redact",
  "history_repair",
  "history_salvage",
  "import",
  "improvement_observe",
  "learning_add",
  "learning_edit",
  "learning_delete",
  "normalize",
  "note_add",
  "note_edit",
  "note_delete",
  "plan_create_metadata",
  "plan_create_initial_step",
  "plan_add_step",
  "plan_reorder_step",
  "plan_remove_step",
  "plan_link_step",
  "plan_unlink_step",
  "plan_append_decision",
  "plan_append_discovery",
  "plan_append_validation",
  "plan_resume",
  "plan_approve",
  "plan_materialize",
  "plan_update_step",
  "plan_complete_step",
  "plan_block_step",
  "policy_approve",
  "policy_refused",
  "release",
  "reopen",
  "restore",
  "schema_migration",
  "schema_migration_reference",
  "test_run_track",
  "tests_add",
  "tests_remove",
  "tests_update",
  "update",
  "update_audit",
  "update_ownership_bypass",
  "workspace_snapshot_restore",
  "extension_migrations_apply",
  "merge_reconcile",
] as const;

/** Exact singleton identities retained for compatibility with existing workspace streams. */
export const PM_WORKSPACE_HISTORY_OPERATIONS = [
  "history:author-acknowledge",
  "settings:write",
  "init:type_preset",
  "templates:save",
  "profile:apply-types",
  "profile:apply-statuses",
  "profile:apply-fields",
  "profile:apply-config",
  "schema:add-type",
  "schema:remove-type",
  "schema:add-status",
  "schema:remove-status",
  "schema:add-field",
  "schema:remove-field",
  "schema:apply-preset",
  "schema:infer-types",
  "schema:policy-put",
  "schema:policy-remove",
  "schema:policy-mode",
  "assurance:bundle:apply",
  "assurance:gate:verdict",
  "telemetry:install_id",
  "telemetry:first_run_prompt",
  "telemetry:clear",
  "item_format:auto_select_default",
] as const;

/** Retired writer spellings; readers preserve original bytes and may resolve aliases explicitly. */
export const PM_HISTORY_OPERATION_ALIASES: Readonly<Record<string, string>> = {
  "init:type-preset": "init:type_preset",
};

/** Parameterized operation families whose operands are governed by their owning SDK contracts. */
export const PM_HISTORY_OPERATION_PATTERNS = [
  "^config:(?:set|unset):[a-z][a-z0-9_.:-]*$",
  "^assurance:(?:measurement|invariant|gate):(?:put|remove)$",
  "^schema_(?:rename_type|rename_status|remap_status|rename_field|remove_type|remove_status|remove_field)(?:_compensate)?$",
  "^extension:[a-z][a-z0-9_-]*:[a-z][a-z0-9_]*$",
] as const;

/** Public immutable-event naming and compatibility contract. */
export const PM_HISTORY_OPERATION_CONTRACT = {
  version: 1,
  item: PM_ITEM_HISTORY_OPERATIONS,
  workspace: PM_WORKSPACE_HISTORY_OPERATIONS,
  aliases: PM_HISTORY_OPERATION_ALIASES,
  patterns: PM_HISTORY_OPERATION_PATTERNS,
  read_policy: "preserve_original_operation",
  custom_operation_grammar: "extension:<package_name>:<snake_case_operation>",
  legacy_custom_operation_grammar:
    "lowercase segments separated by underscore, hyphen, colon, or dot; optional opaque colon-suffixed retry key",
  excluded_surfaces: ["json_patch", "on_write_hook", "telemetry_span"],
} as const;

const declared = new Set<string>([
  ...PM_ITEM_HISTORY_OPERATIONS,
  ...PM_WORKSPACE_HISTORY_OPERATIONS,
]);
const patterns = PM_HISTORY_OPERATION_PATTERNS.map(
  (pattern) => new RegExp(pattern, "u"),
);

/** Resolve known historical aliases without changing or rejecting an immutable record. */
export function resolveHistoryOperation(operation: string): string {
  return Object.hasOwn(PM_HISTORY_OPERATION_ALIASES, operation)
    ? PM_HISTORY_OPERATION_ALIASES[operation]!
    : operation;
}

/** Validate a new operation and return its declared canonical writer spelling. */
export function requireHistoryOperation(operation: string): string {
  const canonical = resolveHistoryOperation(operation);
  if (
    declared.has(canonical) ||
    patterns.some((pattern) => pattern.test(canonical))
  )
    return canonical;
  throw new TypeError(
    "Undeclared history operation; use a native contract identity or extension:<package_name>:<snake_case_operation>.",
  );
}

/** Canonicalize native aliases while retaining well-formed custom SDK operation identities. */
export function normalizeHistoryOperationForWrite(operation: string): string {
  const canonical = resolveHistoryOperation(operation);
  if (/^[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*(?::[^\s\p{C}]+)?$/u.test(canonical)) return canonical;
  throw new TypeError(
    "History operation must use lowercase alphanumeric segments with an optional non-whitespace colon-suffixed retry key.",
  );
}
