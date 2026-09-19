import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeItemDocument, parseItemDocument } from "../../../../src/core/item/item-format.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import { runValidate } from "../../../../src/sdk/governance/validate.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import { describe, expect, it } from "vitest";
import { createHistoryEntry, sealHistoryRecord } from "../../../../src/core/history/history.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../../src/core/shared/constants.js";
import type { HistoryEntry, ItemDocument } from "../../../../src/types/index.js";
import { deriveClosureTimestamp, applyClosureTimestampFix } from "../../../../src/sdk/governance/closure-timestamps.js";

const terminal = new Set(["closed", "canceled"]);

function historyFor(states: string[], operations = states.map((_, index) => index === 0 ? "create" : "update")) {
  let document: ItemDocument = structuredClone(EMPTY_CANONICAL_DOCUMENT);
  const history: HistoryEntry[] = [];
  states.forEach((status, index) => {
    const next: ItemDocument = {
      metadata: { id: "pm-proof", title: "Closure proof", description: "Verified lifecycle fixture", type: "Task", status, priority: 2, tags: [], author: "test", close_reason: "Delivered", created_at: "2026-01-01T00:00:00.000Z", updated_at: `2026-01-0${index + 1}T00:00:00.000Z` },
      body: "",
    };
    history.push(createHistoryEntry({ before: document, after: next, op: operations[index], author: "test", nowIso: next.metadata.updated_at }));
    document = next;
  });
  return { document, history };
}

describe("verified closure timestamp derivation", () => {
  it("selects the latest uninterrupted terminal interval, preserving the first close through metadata edits", () => {
    const { document, history } = historyFor(["open", "closed", "open", "closed", "closed"]);
    expect(deriveClosureTimestamp(history, document, terminal)).toEqual({ timestamp: "2026-01-04T00:00:00.000Z", source_index: 4 });
  });
  it("accepts genuine terminal creation and cancellation", () => {
    const { document, history } = historyFor(["canceled"]);
    expect(deriveClosureTimestamp(history, document, terminal)).toEqual({ timestamp: "2026-01-01T00:00:00.000Z", source_index: 1 });
  });
  it("refuses missing, invalid, drifted, active and checkpoint-only evidence", () => {
    const { document, history } = historyFor(["closed"]);
    expect(deriveClosureTimestamp([], document, terminal)).toHaveProperty("reason", "missing_history");
    expect(deriveClosureTimestamp(history, { ...document, body: "drift" }, terminal)).toHaveProperty("reason", "unverified_history");
    expect(deriveClosureTimestamp([{ ...history[0], after_hash: "wrong" }], document, terminal)).toHaveProperty("reason", "unverified_history");
    const active = historyFor(["open"]);
    expect(deriveClosureTimestamp(active.history, active.document, terminal)).toHaveProperty("reason", "not_terminal");
    const checkpoint = historyFor(["closed"], ["history_compact_baseline"]);
    expect(deriveClosureTimestamp(checkpoint.history, checkpoint.document, terminal)).toHaveProperty("reason", "no_proven_transition");
    const invalidDate = sealHistoryRecord({ ...history[0], ts: "not-a-date" });
    expect(deriveClosureTimestamp([invalidDate], document, terminal)).toHaveProperty("reason", "no_proven_transition");
  });
});


it("previews, gates, applies and verifies real legacy repair without changing unproven history", async () => {
  await withTempPmPath(async ({ pmPath }) => {
    const { document, history } = historyFor(["open", "closed", "closed"]);
    const itemPath = path.join(pmPath, "tasks", "pm-proof.toon");
    await mkdir(path.dirname(itemPath), { recursive: true });
    await writeFile(itemPath, serializeItemDocument(document, { format: "toon" }));
    await writeFile(getHistoryPath(pmPath, "pm-proof"), history.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const global = { path: pmPath, json: true };
    const options = { checkMetadata: true, autoFix: true, fixScope: ["timestamps"] };
    const before = await readFile(itemPath, "utf8");
    expect(parseItemDocument(before, { format: "toon" }).metadata.id).toBe("pm-proof");
    const plain = await runValidate({ checkMetadata: true }, global);
    expect(plain.warnings).toEqual(["validate_metadata_missing_closed_at:1"]);
    expect(plain.checks[0].details).toMatchObject({ missing_closed_at_count: 1, closure_history_inspected: false });
    const gated = await runValidate({ checkMetadata: true, autoFix: true, dryRun: true }, global);
    expect(gated.fixes?.gated_fixes).toEqual(expect.arrayContaining([expect.objectContaining({ field: "closed_at", gate: "timestamps" })]));
    const preview = await runValidate({ ...options, dryRun: true }, global);
    expect(preview.fixes).toMatchObject({ applied_count: 0, gated_count: 0 });
    expect(preview.checks[0].details).toMatchObject({ closure_timestamp_derivable_count: 1, closure_timestamp_residual_count: 0 });
    expect(await readFile(itemPath, "utf8")).toBe(before);
    const applied = await runValidate(options, global);
    expect(applied.fixes).toMatchObject({ applied_count: 1, failed_count: 0 });
    const repaired = parseItemDocument(await readFile(itemPath, "utf8"), { format: "toon" });
    expect(repaired.metadata.closed_at).toBe("2026-01-02T00:00:00.000Z");
    expect(repaired.metadata.completed_at).toBeUndefined();
    const replayed = (await readFile(getHistoryPath(pmPath, "pm-proof"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
    expect(replayed).toHaveLength(history.length + 1);
    expect(deriveClosureTimestamp(replayed, repaired, terminal)).toHaveProperty("timestamp", "2026-01-02T00:00:00.000Z");
    expect((await runValidate(options, global)).fixes).toMatchObject({ planned_count: 0, applied_count: 0 });
    const fix = { item_id: "pm-proof", check: "metadata", field: "closed_at", kind: "set_closed_at", command: "", value: "wrong" } as const;
    await applyClosureTimestampFix(fix, global);
    expect(await readFile(getHistoryPath(pmPath, "pm-proof"), "utf8")).toBe(replayed.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(itemPath, before);
    await writeFile(getHistoryPath(pmPath, "pm-proof"), history.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await expect(applyClosureTimestampFix(fix, global)).rejects.toThrow("evidence changed");
    await writeFile(getHistoryPath(pmPath, "pm-proof"), "broken json\n");
    const residual = await runValidate({ ...options, dryRun: true }, global);
    expect(residual.checks[0].details).toMatchObject({ closure_timestamp_residual_count: 1, closure_timestamp_residual: [{ id: "pm-proof", reason: "unreadable_history" }] });
    await writeFile(getHistoryPath(pmPath, "pm-proof"), "");
    expect((await runValidate({ ...options, dryRun: true }, global)).checks[0].details).toMatchObject({ closure_timestamp_residual: [{ id: "pm-proof", reason: "missing_history" }] });
    await expect(applyClosureTimestampFix(fix, global)).rejects.toThrow("evidence changed");
  });
});
