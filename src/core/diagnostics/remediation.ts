/**
 * Shared machine-executable remediation registry.
 *
 * `pm health` and `pm validate` both emit stable, colon-delimited warning tokens
 * (for example `history_drift_missing_stream:pm-abcd` or
 * `validate_resolution_missing_fields:3`). Agents that gate on these commands
 * previously had to hardcode the mapping from a warning code to the `pm` command
 * that fixes it. This module is the single source of truth for that mapping so
 * `pm health --json` (per-check `remediation_map`) and `pm validate --fix-hints`
 * (per-check `fix_hints`) can both surface executable remediation without any
 * duplicated, drift-prone lookup tables.
 *
 * Semantics of {@link RemediationEntry.command}: the suggested next `pm` command
 * an operator/agent should run to resolve findings with that code. Per-item
 * findings use an `<id>` placeholder (callers that have the concrete id may
 * substitute it); findings whose only fix is a manual file edit point at the
 * most useful diagnostic/repair command and describe the manual step in
 * {@link RemediationEntry.summary}.
 */

export interface RemediationEntry {
  /**
   * Stable warning-code prefix this entry resolves. A warning matches when it
   * equals this code or begins with `<code>:`. Registry codes are mutually
   * exclusive under that colon-boundary rule (no code is a `:`-delimited prefix
   * of another — e.g. `settings:id_prefix_empty` is distinct from a bare
   * `settings`, which is intentionally not registered), so `resolveRemediation`
   * uses first-match with no ordering dependency.
   */
  readonly code: string;
  /** Executable `pm` command (or imperative) that resolves the finding. May contain an `<id>` placeholder. */
  readonly command: string;
  /** One-line description of what the command does / which manual step it covers. */
  readonly summary: string;
}

/**
 * Registry of every non-extension `pm health` / `pm validate` warning code and
 * its remediation. Extension findings keep their richer, contextual
 * `details.triage.remediation` produced by the extension health triage and are
 * intentionally excluded here (see pm-0hnu: "all non-extension checks").
 */
export const REMEDIATION_REGISTRY: readonly RemediationEntry[] = Object.freeze([
  // --- pm health: directories ---
  {
    code: "missing_directory",
    command: "pm init",
    summary: "Recreate missing tracker directories (pm init is idempotent and restores the scaffold).",
  },
  // --- pm health: settings (read/parse) ---
  {
    code: "settings_read_invalid_json",
    command: "pm config list --json",
    summary:
      "settings.json is not valid JSON and pm fell back to defaults; fix the syntax error in the reported path, then re-run.",
  },
  {
    code: "settings_read_invalid_schema",
    command: "pm config list --json",
    summary:
      "settings.json failed schema validation and pm fell back to defaults; correct the reported key in the file, then re-run.",
  },
  {
    code: "settings_read_merge_failed",
    command: "pm config list --json",
    summary: "Global/project settings could not be merged; reconcile the conflicting keys in the reported settings files.",
  },
  // --- pm health: settings_values ---
  {
    code: "settings:id_prefix_empty",
    command: "pm config list --json",
    summary: 'id_prefix is empty; set a non-empty "id_prefix" in settings.json so generated item ids are well-formed.',
  },
  {
    code: "settings:locks_ttl_non_positive",
    command: "pm config list --json",
    summary: 'locks.ttl_seconds must be positive; set a positive "locks.ttl_seconds" in settings.json.',
  },
  // --- pm health: telemetry (advisory) ---
  {
    code: "telemetry_state_invalid_json",
    command: "pm health --check-telemetry",
    summary: "Local telemetry state file is corrupt; pm recreates it on the next flush. Advisory only.",
  },
  {
    code: "telemetry_queue_invalid_rows",
    command: "pm health --check-telemetry",
    summary: "The telemetry queue has unparseable rows; they are skipped on the next flush. Advisory only.",
  },
  {
    code: "telemetry_queue_pending",
    command: "pm health --check-telemetry",
    summary: "Telemetry events are queued; they flush automatically on the next reachable command. Advisory only.",
  },
  {
    code: "telemetry_queue_high_retries",
    command: "pm telemetry flush",
    summary:
      "Some queued telemetry events are near retry exhaustion; flush now and verify endpoint reachability before entries are dropped.",
  },
  {
    code: "telemetry_endpoint_probe_failed",
    command: "pm health --check-telemetry",
    summary: "The telemetry endpoint is unreachable; events stay queued until it recovers. Advisory only.",
  },
  {
    code: "telemetry_endpoint_probe_http_status",
    command: "pm health --check-telemetry",
    summary: "The telemetry endpoint returned a non-success status; events stay queued until it recovers. Advisory only.",
  },
  {
    code: "telemetry_schema_version_behind",
    command: "pm health --check-telemetry",
    summary: "Client schema is behind server; upgrade pm-cli to emit the latest event shape.",
  },
  // --- pm health: integrity ---
  {
    code: "integrity_item_unreadable",
    command: "pm validate --check-files --verbose-diagnostics",
    summary: "An item file could not be read; restore or repair the file at the reported path.",
  },
  {
    code: "integrity_item_parse_failed",
    command: "pm validate --check-files --verbose-diagnostics",
    summary: "An item file failed to parse; fix the malformed front matter at the reported path.",
  },
  {
    code: "integrity_item_conflict_marker",
    command: "pm validate --check-files --verbose-diagnostics",
    summary: "An item file contains Git conflict markers; resolve the <<<<<<< / >>>>>>> markers at the reported line.",
  },
  {
    code: "integrity_history_unreadable",
    command: "pm history-repair <id>",
    summary: "A history stream could not be read; re-anchor the affected item's history chain.",
  },
  {
    code: "integrity_history_invalid_json",
    command: "pm history-repair <id>",
    summary: "A history stream contains invalid JSON; re-anchor the affected item's history chain.",
  },
  {
    code: "integrity_history_conflict_marker",
    command: "pm history-repair <id>",
    summary: "A history stream contains Git conflict markers; resolve the markers, then re-anchor the chain.",
  },
  // --- pm health: history_drift ---
  // `pm health` rewrites these commands to `pm history-repair --all` in the
  // per-check remediation_map when more than one stream is drifted.
  {
    code: "history_drift_missing_stream",
    command: "pm history-repair <id>",
    summary: "The item has no history stream; re-anchor the chain to rebuild it (pm history-repair --all repairs every drifted stream in one pass).",
  },
  {
    code: "history_drift_unreadable_stream",
    command: "pm history-repair <id>",
    summary: "The item's history stream is unreadable; re-anchor the chain (pm history-repair --all repairs every drifted stream in one pass).",
  },
  {
    code: "history_drift_hash_mismatch",
    command: "pm history-repair <id>",
    summary: "The item's content hash no longer matches its history; re-anchor the chain (pm history-repair --all repairs every drifted stream in one pass).",
  },
  {
    code: "history_drift_chain_mismatch",
    command: "pm history-repair <id>",
    summary: "The item's history chain is broken; re-anchor the chain (pm history-repair --all repairs every drifted stream in one pass).",
  },
  // --- pm health: locks ---
  {
    code: "locks_stale_count",
    command: "pm gc --scope locks",
    summary:
      "Stale item-claim locks (embedded ttl elapsed) can block mutations; sweep them — gc retains active and unparseable locks.",
  },
  {
    code: "locks_unreadable",
    command: "pm gc --scope locks --dry-run",
    summary:
      "Some lock files could not be read; preview the sweep and inspect the unreadable files manually — gc never deletes what it cannot read.",
  },
  // --- pm health: vectorization ---
  {
    code: "vectorization_stale_items_remaining",
    command: "pm health --refresh-vectors",
    summary: "Some items have stale embeddings; refresh vectors so semantic search results stay current.",
  },
  {
    code: "vectorization_embedding_identity_changed",
    command: "pm reindex --mode semantic",
    summary: "Embedding provider/model changed since the last index; run a semantic reindex to rebuild vectors.",
  },
  // --- pm validate: metadata ---
  // Note: validate_metadata_missing_author has no entry on purpose. `pm update
  // --author` sets the mutation/audit author (history), not the item's
  // `metadata.author` front-matter field, and there is no CLI flag that writes
  // that field — so emitting a command here would record an audit entry without
  // clearing the finding. A missing item author must be restored at the source.
  {
    code: "validate_metadata_missing_acceptance_criteria",
    command: 'pm update <id> --acceptance-criteria "<criteria>"',
    summary: "Backfill the missing acceptance criteria on the reported item(s).",
  },
  {
    code: "validate_metadata_missing_estimate",
    command: 'pm update <id> --estimate "<estimate>"',
    summary: "Backfill the missing estimate on the reported item(s).",
  },
  {
    code: "validate_metadata_missing_close_reason",
    command: 'pm update <id> --close-reason "<reason>"',
    summary: "Backfill the missing close reason on the reported closed item(s).",
  },
  {
    code: "validate_metadata_missing_reviewer",
    command: 'pm update <id> --reviewer "<name>"',
    summary: "Backfill the missing reviewer on the reported item(s).",
  },
  {
    code: "validate_metadata_missing_risk",
    command: 'pm update <id> --risk "<level>"',
    summary: "Backfill the missing risk on the reported item(s).",
  },
  {
    code: "validate_metadata_missing_confidence",
    command: 'pm update <id> --confidence "<level>"',
    summary: "Backfill the missing confidence on the reported item(s).",
  },
  {
    code: "validate_metadata_missing_sprint",
    command: 'pm update <id> --sprint "<sprint>"',
    summary: "Backfill the missing sprint on the reported item(s).",
  },
  {
    code: "validate_metadata_missing_release",
    command: 'pm update <id> --release "<release>"',
    summary: "Backfill the missing release on the reported item(s).",
  },
  {
    code: "validate_metadata_custom_profile_missing_required_fields",
    command: 'pm config set metadata-required-fields --criterion "<field>"',
    summary:
      "Config-driven finding: the custom metadata profile has no required fields configured and falls back to core, so configure the fields rather than mutating items.",
  },
  // --- pm validate: resolution ---
  {
    code: "validate_resolution_missing_fields",
    command: 'pm update <id> --resolution "<how resolved>"',
    summary: "Backfill resolution / expected_result / actual_result on the reported closed item(s).",
  },
  // --- pm validate: lifecycle ---
  {
    code: "validate_lifecycle_active_closure_like_metadata",
    command: "pm update <id> --unset <closure-like-field>",
    summary:
      "Clear the closure-like field the validator flags on this active item — the detail row names it (resolution / actual-result / blocked-reason) — or close the item if it is actually done.",
  },
  {
    code: "validate_lifecycle_active_terminal_parent",
    command: "pm update <id> --parent <active-parent-id>",
    summary: "Reopen the terminal parent or move the active child under a non-terminal parent.",
  },
  {
    code: "validate_lifecycle_stale_blockers",
    command: "pm update <id> --unset blocked-by --unset blocked-reason",
    summary:
      "Resolve the stale blocker the validator flags: clear blocked-by/blocked-reason when they linger on a non-blocked item or report a resolved blocker; if instead a blocked item is missing blocker context, add the context or move it out of a blocked status.",
  },
  {
    code: "validate_lifecycle_dependency_cycles_error",
    command: "pm update <id> --dep-remove <dep-id>",
    summary: "Break the dependency cycle by removing one edge from the reported cycle.",
  },
  {
    code: "validate_lifecycle_dependency_cycles",
    command: "pm update <id> --dep-remove <dep-id>",
    summary: "Break the dependency cycle by removing one edge from the reported cycle.",
  },
  // --- pm validate: files ---
  {
    code: "validate_files_missing_linked_paths",
    command: "pm <files|docs> <id> --remove <path>",
    summary:
      "The check spans both item.files and item.docs under one code: restore the missing linked artifact, or unlink it with pm files (linked file) or pm docs (linked doc).",
  },
  {
    code: "validate_files_orphaned_paths",
    command: "pm <files|docs> <id> --add <path>",
    summary:
      "Link the orphaned artifact with pm files (file) or pm docs (doc), or remove it from the workspace.",
  },
  {
    code: "validate_files_tracked_all_strict_forces_pm_internals",
    command: "pm validate --check-files --include-pm-internals",
    summary: "tracked-all-strict scan flagged pm internals; re-run with --include-pm-internals or a softer --scan-mode.",
  },
  // --- pm validate: history_drift ---
  {
    code: "validate_history_drift_missing_streams",
    command: "pm history-repair <id>",
    summary: "Re-anchor the history chains of the items missing a history stream.",
  },
  {
    code: "validate_history_drift_unreadable_streams",
    command: "pm history-repair <id>",
    summary: "Re-anchor the history chains of the items with an unreadable history stream.",
  },
  {
    code: "validate_history_drift_hash_mismatches",
    command: "pm history-repair <id>",
    summary: "Re-anchor the history chains of the items whose content hash drifted.",
  },
  {
    code: "validate_history_drift_chain_mismatches",
    command: "pm history-repair <id>",
    summary: "Re-anchor the history chains of the items with a broken history chain.",
  },
  // --- pm validate: command_references ---
  {
    code: "validate_command_references_stale_pm_ids",
    command: 'pm update <id> --replace-tests --test "command=<corrected-command>" [--test ...]',
    summary:
      "Correct the stale pm-ID inside the item's linked test command (the check scans tests[].command, not the body). --replace-tests overwrites the entire tests list, so re-include the item's other linked tests in the same call.",
  },
]);

/**
 * Resolve the remediation entry for a warning token, or `undefined` when no
 * entry is registered. A warning matches an entry when it equals the entry code
 * or begins with `<code>:` (the colon boundary keeps sibling codes such as
 * `validate_lifecycle_dependency_cycles` and
 * `validate_lifecycle_dependency_cycles_error` disjoint).
 *
 * First match is intentional and correct: registry codes are mutually exclusive
 * under the colon-boundary rule, so at most one entry can ever match a warning
 * and order is irrelevant. That invariant is enforced by a test (see
 * remediation-registry.spec.ts "keeps every registry code mutually exclusive"),
 * which is why this stays a simple linear scan rather than a longest-prefix
 * search — a longest-prefix tie-break is unreachable with disjoint codes.
 *
 * Accepts unknown input defensively (this is an exported helper SDK consumers
 * may call from untyped JS): a non-string `warning` resolves to `undefined`.
 */
export function resolveRemediation(warning: string): RemediationEntry | undefined {
  if (typeof warning !== "string") {
    return undefined;
  }
  const normalized = warning.trim();
  for (const entry of REMEDIATION_REGISTRY) {
    if (normalized === entry.code || normalized.startsWith(`${entry.code}:`)) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Build a compact `remediation_map` (code -> command) for a set of warning
 * tokens. First match wins per code; unknown codes are skipped. Used by
 * `pm health --json` per-check details and as the source of deduped executable
 * commands for `pm validate --fix-hints`.
 */
export function buildRemediationMap(warnings: Iterable<string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const warning of warnings) {
    const entry = resolveRemediation(warning);
    if (entry !== undefined && !Object.prototype.hasOwnProperty.call(map, entry.code)) {
      map[entry.code] = entry.command;
    }
  }
  return map;
}

/**
 * Build a deduped, ordered list of executable remediation commands for a set of
 * warning tokens (one command per distinct matched code). Used by
 * `pm validate --fix-hints` for checks that do not already emit per-row
 * remediation commands.
 */
export function buildRemediationCommands(warnings: Iterable<string>): string[] {
  return Object.values(buildRemediationMap(warnings));
}
