function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toItemId(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  const directId = typeof record.id === "string" ? record.id.trim() : "";
  if (directId.length > 0) {
    return directId;
  }
  const item = asRecord(record.item);
  const nestedId = item && typeof item.id === "string" ? item.id.trim() : "";
  return nestedId.length > 0 ? nestedId : null;
}

function toCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fallbackSummary(command: string): string {
  return `Executed ${command} successfully.`;
}

function resolveSummary(command: string, result: unknown): string {
  const record = asRecord(result);
  if (!record) {
    return fallbackSummary(command);
  }
  const itemId = toItemId(result);
  switch (command) {
    case "create":
      return itemId ? `Created item ${itemId}.` : "Created item.";
    case "update":
      return itemId ? `Updated item ${itemId}.` : "Updated item.";
    case "close":
      return itemId ? `Closed item ${itemId}.` : "Closed item.";
    case "delete":
      return itemId ? `Deleted item ${itemId}.` : "Deleted item.";
    case "append":
      return itemId ? `Appended body content for ${itemId}.` : "Appended body content.";
    case "claim":
      return itemId ? `Claimed item ${itemId}.` : "Claimed item.";
    case "release":
      return itemId ? `Released claim for ${itemId}.` : "Released claim.";
    case "get":
      return itemId ? `Loaded item ${itemId}.` : "Loaded item details.";
    case "history":
      return itemId ? `Loaded history for ${itemId}.` : "Loaded item history.";
    case "comments":
      return itemId ? `Loaded comments for ${itemId}.` : "Loaded comments.";
    case "notes":
      return itemId ? `Loaded notes for ${itemId}.` : "Loaded notes.";
    case "learnings":
      return itemId ? `Loaded learnings for ${itemId}.` : "Loaded learnings.";
    case "files":
      return itemId ? `Updated linked files for ${itemId}.` : "Updated linked files.";
    case "docs":
      return itemId ? `Updated linked docs for ${itemId}.` : "Updated linked docs.";
    case "test":
      if ("started" in record && "run" in record) {
        const run = asRecord(record.run);
        const runId = run && typeof run.id === "string" ? run.id : null;
        const started = record.started === true;
        if (started) {
          return runId ? `Started background test run ${runId} for ${itemId ?? "item tests"}.` : "Started background test run.";
        }
        return runId ? `Reused active background test run ${runId}.` : "Background test run already active.";
      }
      return itemId ? `Processed linked tests for ${itemId}.` : "Processed linked tests.";
    case "test-all": {
      if ("started" in record && "run" in record) {
        const run = asRecord(record.run);
        const runId = run && typeof run.id === "string" ? run.id : null;
        const started = record.started === true;
        if (started) {
          return runId ? `Started background test-all run ${runId}.` : "Started background test-all run.";
        }
        return runId ? `Reused active background run ${runId}.` : "Background test-all run already active.";
      }
      const failed = toCount(record, "failed");
      if (failed !== null) {
        return failed > 0 ? `Finished test-all with ${failed} failing result group(s).` : "Finished test-all with no failures.";
      }
      return "Finished test-all run.";
    }
    case "test-runs list": {
      const count = toCount(record, "count");
      return count !== null ? `Listed ${count} background test run(s).` : "Listed background test runs.";
    }
    case "test-runs status": {
      const run = asRecord(record.run);
      const runId = run && typeof run.id === "string" ? run.id : null;
      return runId ? `Loaded background run status for ${runId}.` : "Loaded background run status.";
    }
    case "test-runs logs":
      return "Loaded background run logs.";
    case "test-runs stop":
      return "Requested stop for background test run.";
    case "test-runs resume":
      return "Started resumed background test run.";
    case "list":
    case "list-all":
    case "list-draft":
    case "list-open":
    case "list-in-progress":
    case "list-blocked":
    case "list-closed":
    case "list-canceled": {
      const count = toCount(record, "count");
      return count !== null ? `Returned ${count} item(s).` : "Returned list results.";
    }
    case "search": {
      const count = toCount(record, "count");
      const mode = typeof record.mode === "string" ? record.mode : "keyword";
      return count !== null ? `Search returned ${count} item(s) in ${mode} mode.` : `Search completed in ${mode} mode.`;
    }
    case "reindex": {
      const mode = typeof record.mode === "string" ? record.mode : "keyword";
      const total = toCount(record, "total_items");
      return total !== null ? `Reindexed ${total} item(s) in ${mode} mode.` : `Reindex completed in ${mode} mode.`;
    }
    case "calendar": {
      const view = typeof record.view === "string" ? record.view : "agenda";
      const summary = asRecord(record.summary);
      const total = summary && typeof summary.total === "number" ? summary.total : null;
      return total !== null ? `Calendar ${view} view returned ${total} event(s).` : `Calendar ${view} view completed.`;
    }
    case "activity": {
      const count = toCount(record, "count");
      return count !== null ? `Returned ${count} activity entry(ies).` : "Loaded activity stream.";
    }
    case "stats":
      return "Loaded tracker statistics.";
    case "health":
      return "Loaded tracker health diagnostics.";
    case "gc":
      return "Garbage collection summary completed.";
    case "config":
      return "Config command completed.";
    case "init":
      return "Tracker initialization completed.";
    case "restore":
      return itemId ? `Restored item ${itemId}.` : "Restore command completed.";
    case "completion":
      return "Generated completion script.";
    default:
      return fallbackSummary(command);
  }
}

function resolveHighlights(command: string, result: unknown): string[] {
  const record = asRecord(result);
  if (!record) {
    return [];
  }
  const highlights: string[] = [];
  const itemId = toItemId(result);
  if (itemId) {
    highlights.push(`item_id=${itemId}`);
  }

  const changedFields = Array.isArray(record.changed_fields) ? record.changed_fields.length : null;
  if (changedFields !== null) {
    highlights.push(`changed_fields=${changedFields}`);
  }

  if (command.startsWith("list")) {
    const count = toCount(record, "count");
    if (count !== null) {
      highlights.push(`count=${count}`);
    }
  }
  if (command === "search") {
    if (typeof record.mode === "string") {
      highlights.push(`mode=${record.mode}`);
    }
    const count = toCount(record, "count");
    if (count !== null) {
      highlights.push(`count=${count}`);
    }
  }
  if (command === "reindex") {
    if (typeof record.mode === "string") {
      highlights.push(`mode=${record.mode}`);
    }
    const totalItems = toCount(record, "total_items");
    if (totalItems !== null) {
      highlights.push(`total_items=${totalItems}`);
    }
    const warnings = Array.isArray(record.warnings) ? record.warnings.length : null;
    if (warnings !== null) {
      highlights.push(`warnings=${warnings}`);
    }
  }
  if (command === "test-all") {
    if ("started" in record && "run" in record) {
      const run = asRecord(record.run);
      if (typeof record.started === "boolean") {
        highlights.push(`started=${record.started ? "true" : "false"}`);
      }
      if (run && typeof run.id === "string") {
        highlights.push(`run_id=${run.id}`);
      }
      if (typeof record.duplicate_of === "string") {
        highlights.push(`duplicate_of=${record.duplicate_of}`);
      }
      return highlights;
    }
    const failed = toCount(record, "failed");
    const passed = toCount(record, "passed");
    const skipped = toCount(record, "skipped");
    if (failed !== null) highlights.push(`failed=${failed}`);
    if (passed !== null) highlights.push(`passed=${passed}`);
    if (skipped !== null) highlights.push(`skipped=${skipped}`);
    const totals = asRecord(record.totals);
    const failureCategories = asRecord(totals?.failure_categories);
    if (failureCategories) {
      for (const key of Object.keys(failureCategories).sort((left, right) => left.localeCompare(right))) {
        const value = failureCategories[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          highlights.push(`failed_${key}=${value}`);
        }
      }
    }
  }
  if (command === "test") {
    if ("started" in record && "run" in record) {
      const run = asRecord(record.run);
      if (typeof record.started === "boolean") {
        highlights.push(`started=${record.started ? "true" : "false"}`);
      }
      if (run && typeof run.id === "string") {
        highlights.push(`run_id=${run.id}`);
      }
      if (typeof record.duplicate_of === "string") {
        highlights.push(`duplicate_of=${record.duplicate_of}`);
      }
      return highlights;
    }
    const count = toCount(record, "count");
    if (count !== null) {
      highlights.push(`linked_tests=${count}`);
    }
    const runResults = Array.isArray(record.run_results) ? record.run_results.length : null;
    if (runResults !== null) {
      highlights.push(`run_results=${runResults}`);
    }
    const failureCategories = asRecord(record.failure_categories);
    if (failureCategories) {
      for (const key of Object.keys(failureCategories).sort((left, right) => left.localeCompare(right))) {
        const value = failureCategories[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          highlights.push(`failed_${key}=${value}`);
        }
      }
    }
  }
  if (command === "calendar") {
    const summary = asRecord(record.summary);
    if (summary && typeof summary.total === "number") {
      highlights.push(`events=${String(summary.total)}`);
    }
    if (typeof record.view === "string") {
      highlights.push(`view=${record.view}`);
    }
  }
  if (command.startsWith("test-runs")) {
    const run = asRecord(record.run);
    if (run && typeof run.id === "string") {
      highlights.push(`run_id=${run.id}`);
    }
    const signalSent = typeof record.signal_sent === "string" ? record.signal_sent : null;
    if (signalSent) {
      highlights.push(`signal=${signalSent}`);
    }
    const health = asRecord(record.health);
    if (health && typeof health.state === "string") {
      highlights.push(`health=${health.state}`);
    }
    const count = toCount(record, "count");
    if (count !== null) {
      highlights.push(`count=${count}`);
    }
  }
  return highlights;
}

function resolveNextSteps(command: string, result: unknown): string[] {
  const itemId = toItemId(result) ?? "pm-<id>";
  switch (command) {
    case "create":
      return [
        `pm files ${itemId} --add "path=<file>,scope=project,note=<context>"`,
        `pm test ${itemId} --add "command=node scripts/run-tests.mjs test,scope=project,timeout_seconds=240"`,
        `pm update ${itemId} --status in_progress --message "Start implementation"`,
      ];
    case "update":
      return [
        `pm get ${itemId}`,
        `pm comments ${itemId} --add "Progress update"`,
        `pm notes ${itemId} --add "Implementation note"`,
      ];
    case "close":
      return [`pm release ${itemId}`, `pm history ${itemId} --limit 10`];
    case "delete":
      return ["pm list-all --limit 20", "pm activity --limit 20"];
    case "claim":
      return [`pm update ${itemId} --status in_progress --message "Start work"`];
    case "release":
      return ["pm list-in-progress --limit 20"];
    case "list":
    case "list-open":
    case "list-in-progress":
    case "list-blocked":
    case "list-all":
      return ["pm get <id>", "pm history <id> --limit 20", "pm update <id> --status in_progress --message \"...\""];
    case "search":
      return ['pm get <id>', 'pm search "<query>" --mode hybrid --include-linked'];
    case "reindex":
      return ['pm search "<query>" --mode hybrid --limit 10'];
    case "test":
      return [`pm test ${itemId} --run --background`, "pm test-runs list --limit 10", "node scripts/run-tests.mjs coverage"];
    case "test-all":
      return ["pm test-all --status in_progress --background", "pm test-runs list --status running", "node scripts/run-tests.mjs coverage"];
    case "test-runs list":
      return ["pm test-runs status <runId>", "pm test-runs logs <runId> --stream stderr --tail 200"];
    case "test-runs status":
      return ["pm test-runs logs <runId> --tail 200", "pm test-runs stop <runId>"];
    case "test-runs stop":
      return ["pm test-runs status <runId>", "pm test-runs resume <runId>"];
    case "test-runs resume":
      return ["pm test-runs status <runId>", "pm test-runs logs <runId> --tail 200"];
    case "calendar":
      return ["pm calendar --view agenda --from +0d --to +7d", "pm calendar --view month --format json"];
    case "init":
      return [
        'pm create --title "Example" --description "..." --type Task --status open --priority 1 --message "Create initial item" --dep none --comment none --note none --learning none --file none --test none --doc none',
      ];
    case "config":
      return ["pm config project get definition-of-done", "pm config project get item-format", "pm config project get test-result-tracking"];
    case "get":
      return [
        `pm history ${itemId} --limit 20`,
        `pm comments ${itemId} --limit 10`,
        `pm notes ${itemId} --limit 10`,
        `pm learnings ${itemId} --limit 10`,
      ];
    case "history":
      return ["pm restore <id> <timestamp|version>", "pm activity --limit 20"];
    case "activity":
      return ["pm list-in-progress --limit 20", "pm list-blocked --limit 20"];
    case "completion":
      return ["pm completion bash", "pm completion zsh", "pm completion fish"];
    default:
      return [];
  }
}

export function buildCommandAwareEnvelope(command: string, result: unknown): Record<string, unknown> {
  return {
    summary: {
      command,
      message: resolveSummary(command, result),
    },
    highlights: resolveHighlights(command, result),
    next_steps: resolveNextSteps(command, result),
    result,
  };
}
