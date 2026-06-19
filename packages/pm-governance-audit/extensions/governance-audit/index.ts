import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { CommandDefinition, ExtensionApi, OnReadHookContext, OnWriteHookContext } from "../../../../src/sdk/index.js";
import {
  runCommentsAuditPackage,
  runDedupeAuditPackage,
  runDedupeMergePackage,
  runNormalizePackage,
} from "./runtime.js";

export const manifest = {
  name: "builtin-governance-audit",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["commands", "schema", "hooks"],
};

const HOOK_LOG_ENV = "PM_GOVERNANCE_AUDIT_HOOK_LOG";
const createdHookLogDirs = new Set<string>();

const dedupeAuditFlags = [
  { long: "--mode", value_name: "value", value_type: "string", description: "Audit mode: title_exact|title_fuzzy|parent_scope." },
  { long: "--status", value_name: "value", value_type: "string", description: "Filter by status." },
  { long: "--type", value_name: "value", value_type: "string", description: "Filter by item type." },
  { long: "--tag", value_name: "value", value_type: "string", description: "Filter by tag." },
  { long: "--priority", value_name: "value", value_type: "string", description: "Filter by priority." },
  { long: "--deadline-before", value_name: "value", value_type: "string", description: "Filter by deadline upper bound." },
  { long: "--deadline-after", value_name: "value", value_type: "string", description: "Filter by deadline lower bound." },
  { long: "--assignee", value_name: "value", value_type: "string", description: "Filter by assignee." },
  { long: "--assignee-filter", value_name: "value", value_type: "string", description: "Filter assignee presence." },
  { long: "--parent", value_name: "value", value_type: "string", description: "Filter by parent item ID." },
  { long: "--sprint", value_name: "value", value_type: "string", description: "Filter by sprint." },
  { long: "--release", value_name: "value", value_type: "string", description: "Filter by release." },
  { long: "--limit", value_name: "n", value_type: "string", description: "Limit analyzed items." },
  { long: "--threshold", value_name: "value", value_type: "string", description: "Similarity threshold for fuzzy modes." },
] as const;

const dedupeMergeFlags = [
  { long: "--keep", value_name: "id", value_type: "string", description: "Canonical item id to keep (children move here)." },
  { long: "--close", value_name: "ids", value_type: "string", description: "Duplicate item id(s) to consolidate (comma-separated)." },
  { long: "--apply", value_type: "boolean", description: "Apply the merge; omit for a non-mutating preview." },
  { long: "--dry-run", value_type: "boolean", description: "Force a preview even when --apply is also set." },
  { long: "--skip-children", value_type: "boolean", description: "Do not re-parent the duplicates' active children." },
  { long: "--author", value_name: "value", value_type: "string", description: "Author recorded on merge mutations." },
  { long: "--message", value_name: "value", value_type: "string", description: "History message recorded on merge mutations." },
] as const;

const commentsAuditFlags = [
  { long: "--status", value_name: "value", value_type: "string", description: "Filter by status." },
  { long: "--type", value_name: "value", value_type: "string", description: "Filter by item type." },
  { long: "--tag", value_name: "value", value_type: "string", description: "Filter by tag." },
  { long: "--priority", value_name: "value", value_type: "string", description: "Filter by priority." },
  { long: "--parent", value_name: "value", value_type: "string", description: "Filter by parent item ID." },
  { long: "--sprint", value_name: "value", value_type: "string", description: "Filter by sprint." },
  { long: "--release", value_name: "value", value_type: "string", description: "Filter by release." },
  { long: "--assignee", value_name: "value", value_type: "string", description: "Filter by assignee." },
  { long: "--assignee-filter", value_name: "value", value_type: "string", description: "Filter assignee presence." },
  { long: "--limit", value_name: "n", value_type: "string", description: "Limit output rows." },
  { long: "--limit-items", value_name: "n", value_type: "string", description: "Limit scanned items before comment expansion." },
  { long: "--latest", value_name: "n", value_type: "string", description: "Include latest n comments per item." },
  { long: "--full-history", value_type: "boolean", description: "Emit full comment history rows." },
] as const;

const normalizeFlags = [
  { long: "--filter-status", value_name: "value", value_type: "string", description: "Status filter applied before normalize planning." },
  { long: "--filter_status", value_name: "value", value_type: "string", description: "Alias for --filter-status." },
  { long: "--type", value_name: "value", value_type: "string", description: "Filter by item type." },
  { long: "--tag", value_name: "value", value_type: "string", description: "Filter by tag." },
  { long: "--priority", value_name: "value", value_type: "string", description: "Filter by priority." },
  { long: "--deadline-before", value_name: "value", value_type: "string", description: "Filter by deadline upper bound." },
  { long: "--deadline-after", value_name: "value", value_type: "string", description: "Filter by deadline lower bound." },
  { long: "--assignee", value_name: "value", value_type: "string", description: "Filter by assignee." },
  { long: "--assignee-filter", value_name: "value", value_type: "string", description: "Filter assignee presence." },
  { long: "--parent", value_name: "value", value_type: "string", description: "Filter by parent item ID." },
  { long: "--sprint", value_name: "value", value_type: "string", description: "Filter by sprint." },
  { long: "--release", value_name: "value", value_type: "string", description: "Filter by release." },
  { long: "--limit", value_name: "n", value_type: "string", description: "Limit listed items." },
  { long: "--offset", value_name: "n", value_type: "string", description: "Skip first n listed items." },
  { long: "--include-body", value_type: "boolean", description: "Include body while listing candidate items." },
  { long: "--include_body", value_type: "boolean", description: "Alias for --include-body." },
  { long: "--compact", value_type: "boolean", description: "Request compact list projection." },
  { long: "--fields", value_name: "value", value_type: "string", description: "Comma-separated list projection fields." },
  { long: "--sort", value_name: "value", value_type: "string", description: "Sort field." },
  { long: "--order", value_name: "value", value_type: "string", description: "Sort order." },
  { long: "--dry-run", value_type: "boolean", description: "Preview normalize mutations without applying." },
  { long: "--apply", value_type: "boolean", description: "Apply normalize mutations." },
  { long: "--author", value_name: "value", value_type: "string", description: "Author used for apply-mode updates." },
  { long: "--message", value_name: "value", value_type: "string", description: "History message used for apply-mode updates." },
  { long: "--force", value_type: "boolean", description: "Force apply-mode updates." },
  { long: "--allow-audit-update", value_type: "boolean", description: "Allow append-only audit updates across owners." },
  { long: "--allow_audit_update", value_type: "boolean", description: "Alias for --allow-audit-update." },
] as const;

function dedupeAuditCommand(): CommandDefinition {
  return {
    name: "dedupe-audit",
    action: "dedupe-audit",
    description: "Audit likely duplicate items by title and parent scope heuristics.",
    flags: [...dedupeAuditFlags],
    run: async (context) => runDedupeAuditPackage(context.options, context.global),
  };
}

function dedupeMergeCommand(): CommandDefinition {
  return {
    name: "dedupe-merge",
    action: "dedupe-merge",
    description: "Consolidate duplicates into a canonical item: re-parent active children and close duplicates with duplicate_of.",
    flags: [...dedupeMergeFlags],
    run: async (context) => runDedupeMergePackage(context.options, context.global),
  };
}

function commentsAuditCommand(): CommandDefinition {
  return {
    name: "comments-audit",
    action: "comments-audit",
    description: "Audit item comment coverage and export comment history rows.",
    flags: [...commentsAuditFlags],
    run: async (context) => runCommentsAuditPackage(context.options, context.global),
  };
}

function normalizeCommand(): CommandDefinition {
  return {
    name: "normalize",
    action: "normalize",
    description: "Plan/apply lifecycle metadata normalization sweeps.",
    flags: [...normalizeFlags],
    run: async (context) => runNormalizePackage(context.options, context.global),
  };
}

function appendHookAuditRecord(kind: "on_read" | "on_write", context: OnReadHookContext | OnWriteHookContext): void {
  const logPath = process.env[HOOK_LOG_ENV]?.trim();
  if (!logPath) {
    return;
  }
  try {
    const absoluteLogPath = path.resolve(logPath);
    const logDir = path.dirname(absoluteLogPath);
    if (!createdHookLogDirs.has(logDir)) {
      mkdirSync(logDir, { recursive: true });
      createdHookLogDirs.add(logDir);
    }
    const writeContext = kind === "on_write" ? (context as OnWriteHookContext) : undefined;
    appendFileSync(
      absoluteLogPath,
      `${JSON.stringify({
        kind,
        path: context.path,
        scope: context.scope,
        op: writeContext?.op,
        item_id: writeContext?.item_id,
        item_type: writeContext?.item_type,
        changed_fields: writeContext?.changed_fields,
      })}\n`,
      "utf8",
    );
  } catch {
    // Best-effort sidecar logging must not interrupt core read/write flows.
  }
}

export function activate(api: ExtensionApi): void {
  api.registerCommand(dedupeAuditCommand());
  api.registerCommand(dedupeMergeCommand());
  api.registerCommand(commentsAuditCommand());
  api.registerCommand(normalizeCommand());
  api.hooks.onRead((context) => appendHookAuditRecord("on_read", context));
  api.hooks.onWrite((context) => appendHookAuditRecord("on_write", context));
}

export default {
  manifest,
  activate,
};
