/**
 * GH-1713 (pm-gh1713): strict create accepts an explicit, reasoned deferral
 * for deadline, assignee, acceptance criteria and estimate. The deferral is
 * typed item metadata (format 4), resolved by the write that supplies the
 * value, listed by validate and health, and refused by strict close.
 */
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../../../../src/mcp/server.js";
import { PmClient, resolveRuntimeFieldRegistry } from "../../../../src/sdk/runtime.js";
import { _testOnlyCreateCommand } from "../../../../src/sdk/lifecycle/create.js";
import { itemDocumentToMutationOptions } from "../../../../src/sdk/structured-mutations.js";
import {
  DEFERRABLE_ITEM_FIELDS,
  describeInvalidDeferredFields,
  hasConcreteItemFieldValue,
  normalizeDeferredFields,
  outstandingDeferredFields,
  pruneResolvedDeferredFields,
  resolveDeferrableItemField,
} from "../../../../src/core/item/deferred-fields.js";
import { summarizeDeferredFieldCuration } from "../../../../src/sdk/governance/validate-deferred-fields.js";
import { runValidate } from "../../../../src/sdk/governance/validate.js";
import { runHealth } from "../../../../src/sdk/governance/health.js";
import { readHistoryEntries } from "../../../../src/core/history/read.js";
import { readSettings } from "../../../../src/core/store/settings.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";
import type { ItemDocument, ItemMetadata } from "../../../../src/types/index.js";
import { mergeItemDocuments } from "../../../../src/sdk/merge/three-way.js";
import { parseItemDocument, serializeItemDocument } from "../../../../src/core/item/item-format.js";

const STRICT_LINKS = {
  clearDeps: true,
  clearComments: true,
  clearNotes: true,
  clearLearnings: true,
  clearFiles: true,
  clearTests: true,
  clearDocs: true,
};

const STRICT_BASE = {
  title: "Imported issue",
  type: "Issue",
  description: "Mirrored from an external tracker",
  status: "open",
  priority: 2,
  tags: "imported",
  body: "",
  message: "Import",
  createMode: "strict",
  ...STRICT_LINKS,
};

const ALL_DEFERRED = ["deadline", "assignee", "acceptance_criteria", "estimated_minutes"];

describe("strict create deferrals (GH-1713)", () => {
  it("creates a strict item with reasoned deferrals instead of invented values", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, author: "importer" });
      await expect(client.create({ ...STRICT_BASE })).rejects.toMatchObject({ code: "missing_required_option" });

      const created = await client.create({ ...STRICT_BASE, id: "mirrored", defer: ALL_DEFERRED, deferReason: "  Imported from GitHub issue 42  " });
      expect(created.item).toMatchObject({
        pm_format_version: 4,
        deferred_fields: [
          { field: "acceptance_criteria", reason: "Imported from GitHub issue 42" },
          { field: "assignee", reason: "Imported from GitHub issue 42" },
          { field: "deadline", reason: "Imported from GitHub issue 42" },
          { field: "estimated_minutes", reason: "Imported from GitHub issue 42" },
        ],
      });
      expect(created.item.deadline).toBeUndefined();
      expect(created.item.assignee).toBeUndefined();
      expect(created.changed_fields).toContain("deferred_fields");

      // The create history entry records the deferral itself.
      const history = await readHistoryEntries(path.join(context.pmPath, "history", "pm-mirrored.jsonl"), "pm-mirrored");
      expect(JSON.stringify(history[0]?.patch)).toContain("deferred_fields");

      // A comma list and CLI spellings resolve to the same canonical fields.
      const spelled = await client.create({ ...STRICT_BASE, title: "Spelled deferral", deadline: "2026-12-31", assignee: "alice", defer: ["ac,estimate"], deferReason: "Unknown upstream" });
      expect(spelled.item.deferred_fields?.map((entry) => entry.field)).toEqual(["acceptance_criteria", "estimated_minutes"]);
    });
  });

  it("refuses silent, contradictory and unsupported deferrals with typed codes", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, author: "importer" });
      await expect(client.create({ ...STRICT_BASE, defer: ALL_DEFERRED })).rejects.toMatchObject({ code: "create_deferral_reason_required", exitCode: 2 });
      await expect(client.create({ ...STRICT_BASE, defer: ALL_DEFERRED, deferReason: "   " })).rejects.toMatchObject({ code: "create_deferral_reason_required" });
      await expect(client.create({ ...STRICT_BASE, deferReason: "Imported" })).rejects.toMatchObject({ code: "create_deferral_fields_required" });
      await expect(client.create({ ...STRICT_BASE, defer: ["deadline", "priority"], deferReason: "Imported" })).rejects.toMatchObject({ code: "create_deferral_field_unsupported" });
      await expect(client.create({ ...STRICT_BASE, defer: [42] as never, deferReason: "Imported" })).rejects.toMatchObject({ code: "invalid_argument_value" });
      await expect(client.create({ ...STRICT_BASE, defer: ALL_DEFERRED, deferReason: 7 as never })).rejects.toMatchObject({ code: "invalid_argument_value" });
      await expect(client.create({ ...STRICT_BASE, defer: ALL_DEFERRED, deadline: "2026-12-31", deferReason: "Imported" })).rejects.toMatchObject({ code: "create_deferral_conflict" });
      await expect(client.create({ ...STRICT_BASE, defer: ALL_DEFERRED, unset: ["assignee"], deferReason: "Imported" })).rejects.toMatchObject({ code: "create_deferral_conflict" });
      await expect(client.create({ ...STRICT_BASE, defer: ["estimate"], estimatedMinutes: "0", deferReason: "Imported" })).rejects.toMatchObject({ code: "create_deferral_conflict" });
      // An empty defer list defers nothing and is no error.
      await expect(client.create({ ...STRICT_BASE, defer: [], createMode: "progressive", title: "Nothing deferred" })).resolves.toMatchObject({ item: { title: "Nothing deferred" } });
    });
  });

  it("keeps strict close refusing until every deferred field has a value, which resolves the deferral", async () => {
    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, author: "importer" });
      const created = await client.create({ ...STRICT_BASE, id: "curate", defer: ALL_DEFERRED, deferReason: "Imported" });
      const id = created.item.id;
      const evidence = { resolution: "Done", expectedResult: "Works", actualResult: "Works" };

      await expect(client.close(id, "Done", { ...evidence, validateClose: "strict" })).rejects.toMatchObject({
        code: "close_validation_deferred_fields",
        context: {
          recovery: {
            missing: ["--acceptance-criteria", "--assignee", "--deadline", "--estimate"],
            next_best_command: expect.stringContaining(`update ${id} --author=importer --acceptance-criteria`),
          },
        },
      });

      // An ownership override carries into the recovery, so the corrective update is not refused either.
      await expect(client.close(id, "Done", { ...evidence, validateClose: "strict", force: true })).rejects.toMatchObject({
        context: { recovery: { next_best_command: expect.stringContaining("--author=importer --force") } },
      });
      // Without an explicit author the recovery names none, and the update resolves the author as usual.
      await expect(new PmClient({ pmRoot: context.pmPath }).close(id, "Done", { ...evidence, validateClose: "strict" })).rejects.toMatchObject({
        code: "close_validation_deferred_fields",
        context: { recovery: { next_best_command: expect.not.stringContaining("--author") } },
      });

      const partial = await client.update(id, { deadline: "2026-12-31", estimatedMinutes: "30" });
      expect(partial.changed_fields).toContain("deferred_fields");
      expect(partial.item.deferred_fields?.map((entry) => entry.field)).toEqual(["acceptance_criteria", "assignee"]);

      const validation = (await runValidate({ checkMetadata: true }, { path: context.pmPath })) as Awaited<ReturnType<typeof runValidate>> & { checks: Array<{ name: string; details: unknown }>; warnings: string[] };
      const metadata = validation.checks.find((check) => check.name === "metadata");
      expect(validation.warnings).toContain("validate_metadata_deferred_fields:1");
      expect(metadata?.details).toMatchObject({
        deferred_fields: { items: 1, by_field: { acceptance_criteria: 1, assignee: 1 }, rows: [{ id, fields: ["acceptance_criteria", "assignee"], reasons: ["Imported"] }], truncated: false },
      });
      const health = await runHealth({ path: context.pmPath } as never);
      expect(health.checks.find((check) => check.name === "integrity")?.details).toMatchObject({
        curation: { deferred_fields: { items: 1 } },
      });

      // Warn mode closes with a typed warning; the open deferrals stay listed as curation work.
      const warned = await client.create({ ...STRICT_BASE, title: "Warn close", defer: ["deadline"], assignee: "importer", acceptanceCriteria: "ok", estimatedMinutes: "5", deferReason: "Imported" });
      const warnClose = await client.close(warned.item.id, "Done", { ...evidence, validateClose: "warn" });
      expect(warnClose.warnings).toContain(`close_validation_deferred_fields:${warned.item.id}:deadline`);
      expect(warnClose.item.deferred_fields).toEqual([{ field: "deadline", reason: "Imported" }]);

      const resolved = await client.update(id, { acceptanceCriteria: "Mirrors the upstream issue", assignee: "importer" });
      expect(resolved.item.deferred_fields).toBeUndefined();
      expect(resolved.item.pm_format_version).toBe(4);
      await expect(client.close(id, "Done", { ...evidence, validateClose: "strict" })).resolves.toMatchObject({ item: { status: "closed" } });
    });
  });

  it("rolls back a deferred create on a strict tracker and judges schema-field values like core options", async () => {
    await withTempPmPath(async (context) => {
      const settings = await readSettings(context.pmPath);
      settings.governance.preset = "strict";
      // A schema field whose metadata key is a deferrable core field supplies that value.
      settings.schema.fields = [{ key: "due", metadata_key: "deadline", cli_flag: "due", type: "string" }];
      await writeFile(path.join(context.pmPath, "settings.json"), JSON.stringify(settings));
      const client = new PmClient({ pmRoot: context.pmPath, author: "importer" });
      await expect(client.create({ ...STRICT_BASE, defer: ["deadline"], due: "2026-12-31", deferReason: "Imported" } as never)).rejects.toMatchObject({ code: "create_deferral_conflict" });

      // A later row fails: the strict close validation must not refuse the rollback of the deferred create.
      await expect(client.commitItemMutations({
        transactionId: "gh1713-rollback",
        mutations: [
          { op: "create", id: "pm-rolled-back", options: { ...STRICT_BASE, title: "Rolled back", defer: ALL_DEFERRED, deferReason: "Imported" } },
          { op: "update", id: "pm-missing-row", options: { description: "fails" } },
        ],
      })).rejects.not.toBeInstanceOf(AggregateError);
      await expect(client.get("pm-rolled-back")).resolves.toMatchObject({ item: { status: "closed", close_reason: expect.stringContaining("Compensated") } });

      // The corrective update of a strict close refusal runs as the identity the close ran as.
      const owned = await client.create({ ...STRICT_BASE, title: "Owned deferral", defer: ["deadline"], assignee: "alice", acceptanceCriteria: "ok", estimatedMinutes: "5", deferReason: "Imported" });
      await expect(client.close(owned.item.id, "Done", { author: "alice", resolution: "r", expectedResult: "e", actualResult: "a" })).rejects.toMatchObject({
        code: "close_validation_deferred_fields",
        context: { recovery: { next_best_command: expect.stringContaining("--author=alice") } },
      });
    });
  });

  it("accepts the deferral through the CLI and MCP surfaces", async () => {
    await withTempPmPath(async (context) => {
      const cli = context.runCli([
        "create", "CLI import", "--type", "Issue", "--description", "x", "--status", "open", "--priority", "2", "--tags", "imported", "--body", "", "--message", "Import",
        "--create-mode", "strict", "--clear-deps", "--clear-comments", "--clear-notes", "--clear-learnings", "--clear-files", "--clear-tests", "--clear-docs",
        "--defer", "deadline", "--defer", "assignee,ac", "--defer", "estimate", "--defer-reason", "Imported from Linear", "--id", "cli-import", "--json",
      ], { expectJson: true });
      expect(cli.code).toBe(0);
      const stored = await readFile(path.join(context.pmPath, "issues", "pm-cli-import.toon"), "utf8");
      expect(stored).toContain("deferred_fields[4]{field,reason}:");
      expect(stored).toContain("pm_format_version: 4");

      const mcp = await handleRequest({
        jsonrpc: "2.0",
        id: "mcp-create",
        method: "tools/call",
        params: { name: "pm_create", arguments: { path: context.pmPath, ...STRICT_BASE, id: "mcp-import", defer: ["deadline", "assignee", "acceptance_criteria", "estimated_minutes"], deferReason: "Imported over MCP" } },
      });
      expect(JSON.stringify(mcp?.structuredContent)).toContain("pm-mcp-import");
      await expect(new PmClient({ pmRoot: context.pmPath }).get("pm-mcp-import")).resolves.toMatchObject({ item: { deferred_fields: expect.arrayContaining([{ field: "deadline", reason: "Imported over MCP" }]) } });

      // An importer's atomic batch defers the same way, so one unknown deadline no longer rolls the sync back.
      const importer = new PmClient({ pmRoot: context.pmPath, author: "importer" });
      await importer.commitItemMutations({
        transactionId: "gh1713-sync",
        mutations: [
          { op: "create", id: "pm-sync-a", options: { ...STRICT_BASE, title: "Synced A", defer: ALL_DEFERRED, deferReason: "Imported from GitHub" } },
          { op: "create", id: "pm-sync-b", options: { ...STRICT_BASE, title: "Synced B", defer: ["deadline"], assignee: "importer", acceptanceCriteria: "Mirrors upstream", estimatedMinutes: "15", deferReason: "Imported from GitHub" } },
        ],
      });
      await expect(importer.get("pm-sync-b")).resolves.toMatchObject({ item: { pm_format_version: 4, deferred_fields: [{ field: "deadline", reason: "Imported from GitHub" }] } });
    });
  });

  it("round-trips system-maintained metadata and deferrals through the stdin-json document adapter (pm-o74zyh)", async () => {
    const stored = {
      id: "pm-mirrored", title: "Mirrored", type: "Issue", status: "open", priority: 2, tags: ["imported"],
      pm_format_version: 4, claim_principal: "harness:codex#abc123", test_runs: [{ ran_at: "2026-11-14T00:00:00.000Z" }],
      deferred_fields: [{ field: "deadline", reason: "Imported" }, { field: "assignee", reason: " Imported " }, { field: "estimated_minutes", reason: "Unknown size" }, { note: "malformed" }],
    };
    const envelope = JSON.stringify({ item: stored });
    const update = itemDocumentToMutationOptions(envelope, "update");
    for (const key of ["pm_format_version", "pmFormatVersion", "claim_principal", "claimPrincipal", "test_runs", "testRuns", "deferred_fields", "defer", "deferReason", "field"]) {
      expect(update).not.toHaveProperty(key);
    }
    const create = itemDocumentToMutationOptions(envelope, "create");
    expect(create).toMatchObject({ defer: ["deadline", "assignee", "estimated_minutes"], deferReason: "Imported; Unknown size" });
    expect(create).not.toHaveProperty("field");
    expect(itemDocumentToMutationOptions(JSON.stringify({ ...stored, deferred_fields: [{ field: "deadline" }] }), "create")).toMatchObject({ defer: ["deadline"] });
    expect(itemDocumentToMutationOptions(JSON.stringify({ ...stored, deferred_fields: [{ field: "deadline" }] }), "create")).not.toHaveProperty("deferReason");
    expect(itemDocumentToMutationOptions(JSON.stringify({ ...stored, deferred_fields: "deadline" }), "create")).not.toHaveProperty("defer");
    // Explicit values and unsets override the document's deferral of that field, like any other document value.
    const overridden = itemDocumentToMutationOptions(envelope, "create", { deadline: "2026-12-31", unset: ["assignee"] });
    expect(overridden).toMatchObject({ defer: ["estimated_minutes"], deadline: "2026-12-31" });
    const allOverridden = itemDocumentToMutationOptions(envelope, "create", { deadline: "2026-12-31", assignee: "alice", estimatedMinutes: "30" });
    expect(allOverridden).not.toHaveProperty("defer");
    expect(allOverridden).not.toHaveProperty("deferReason");
    expect(itemDocumentToMutationOptions(envelope, "create", { defer: ["deadline"], deferReason: "Explicit" })).toMatchObject({ defer: ["deadline"], deferReason: "Explicit" });
    // Each remaining field contributes only its own reason; one without a reason gets none synthesized.
    expect(itemDocumentToMutationOptions(JSON.stringify({ ...stored, deferred_fields: [{ field: "deadline", reason: "A" }, { field: "assignee", reason: "B" }] }), "create", { deadline: "2026-12-31" })).toMatchObject({ defer: ["assignee"], deferReason: "B" });
    const borrowed = itemDocumentToMutationOptions(JSON.stringify({ ...stored, deferred_fields: [{ field: "deadline", reason: "Imported" }, { field: "assignee" }] }), "create");
    expect(borrowed).toMatchObject({ defer: ["deadline", "assignee"] });
    expect(borrowed).not.toHaveProperty("deferReason");

    await withTempPmPath(async (context) => {
      const client = new PmClient({ pmRoot: context.pmPath, author: "importer" });
      await client.create({ ...STRICT_BASE, id: "round-trip", defer: ALL_DEFERRED, deferReason: "Imported" });
      const document = context.runCli(["get", "pm-round-trip", "--json"], { expectJson: true });
      expect(document.code).toBe(0);
      const updated = context.runCli(["update", "pm-round-trip", "--stdin-json", "--description", "Curated", "--json"], { expectJson: true, input: JSON.stringify(document.json) });
      expect(updated.code).toBe(0);
      const recreated = context.runCli(["create", "--stdin-json", "--id", "recreated", "--title", "Recreated import", "--json"], { expectJson: true, input: JSON.stringify(document.json) });
      expect(recreated.code).toBe(0);
      await expect(client.get("pm-recreated")).resolves.toMatchObject({ item: { pm_format_version: 4, deferred_fields: expect.arrayContaining([{ field: "deadline", reason: "Imported" }]) } });
    });
  });

  it("merges two branches that each resolve a different deferral without a conflict", () => {
    const deferredBase = {
      metadata: {
        id: "pm-merge", title: "Mirrored", description: "", type: "Issue", status: "open", priority: 2, tags: [],
        created_at: "2026-11-14T00:00:00.000Z", updated_at: "2026-11-14T00:00:00.000Z", pm_format_version: 4,
        deferred_fields: [{ field: "assignee", reason: "Imported" }, { field: "deadline", reason: "Imported" }],
      },
      body: "",
    } as unknown as ItemDocument;
    const ours = structuredClone(deferredBase);
    ours.metadata.deadline = "2026-12-31T00:00:00.000Z";
    ours.metadata.deferred_fields = [{ field: "assignee", reason: "Imported" }];
    ours.metadata.updated_at = "2026-11-14T01:00:00.000Z";
    const theirs = structuredClone(deferredBase);
    theirs.metadata.assignee = "alice";
    theirs.metadata.deferred_fields = [{ field: "deadline", reason: "Imported" }];
    theirs.metadata.updated_at = "2026-11-14T02:00:00.000Z";
    const result = mergeItemDocuments(serializeItemDocument(deferredBase), serializeItemDocument(ours), serializeItemDocument(theirs));
    expect(result.conflict_fields.filter((field) => field !== "updated_at")).toEqual([]);
    expect(result.union_fields).toContain("deferred_fields");
    const merged = parseItemDocument(result.merged, { format: "toon" }).metadata;
    expect(merged).toMatchObject({ deadline: "2026-12-31T00:00:00.000Z", assignee: "alice", pm_format_version: 4 });
    expect(merged.deferred_fields).toBeUndefined();

    // Both sides change one field's reason: the result keeps one entry per field, in either merge order.
    const reasoned = (reason: string, updatedAt: string) => {
      const branch = structuredClone(deferredBase);
      branch.metadata.deferred_fields = [{ field: "assignee", reason: "Imported" }, { field: "deadline", reason }];
      branch.metadata.updated_at = updatedAt;
      return serializeItemDocument(branch);
    };
    const baseRaw = serializeItemDocument(deferredBase);
    const forward = mergeItemDocuments(baseRaw, reasoned("Imported from GitHub", "2026-11-14T01:00:00.000Z"), reasoned("Imported from Linear", "2026-11-14T02:00:00.000Z"));
    const backward = mergeItemDocuments(baseRaw, reasoned("Imported from Linear", "2026-11-14T02:00:00.000Z"), reasoned("Imported from GitHub", "2026-11-14T01:00:00.000Z"));
    const forwardFields = parseItemDocument(forward.merged, { format: "toon" }).metadata.deferred_fields;
    expect(forwardFields).toEqual([{ field: "assignee", reason: "Imported" }, { field: "deadline", reason: "Imported from GitHub" }]);
    expect(parseItemDocument(backward.merged, { format: "toon" }).metadata.deferred_fields).toEqual(forwardFields);

    // One side resolves a field while the other changed its reason: the resolution wins.
    const resolvedSide = structuredClone(deferredBase);
    resolvedSide.metadata.deferred_fields = [{ field: "assignee", reason: "Imported" }];
    resolvedSide.metadata.deadline = "2026-12-31T00:00:00.000Z";
    const resolvedMerge = mergeItemDocuments(baseRaw, serializeItemDocument(resolvedSide), reasoned("Reworded", "2026-11-14T03:00:00.000Z"));
    expect(parseItemDocument(resolvedMerge.merged, { format: "toon" }).metadata.deferred_fields).toEqual([{ field: "assignee", reason: "Imported" }]);

    // One side resolved every deferral (the key is gone); the other kept them unchanged: the resolutions win.
    const allResolved = structuredClone(deferredBase);
    delete allResolved.metadata.deferred_fields;
    allResolved.metadata.deadline = "2026-12-31T00:00:00.000Z";
    allResolved.metadata.assignee = "alice";
    const allResolvedMerge = mergeItemDocuments(baseRaw, baseRaw, serializeItemDocument(allResolved));
    expect(parseItemDocument(allResolvedMerge.merged, { format: "toon" }).metadata.deferred_fields).toBeUndefined();

    // A branch restoring a deferral while the other supplies its value: the merged value resolves the deferral.
    const undeferred = structuredClone(deferredBase);
    delete undeferred.metadata.deferred_fields;
    const restoring = structuredClone(deferredBase);
    restoring.metadata.deferred_fields = [{ field: "deadline", reason: "Restored" }];
    const supplying = structuredClone(undeferred);
    supplying.metadata.deadline = "2027-01-31T00:00:00.000Z";
    const reconciled = mergeItemDocuments(serializeItemDocument(undeferred), serializeItemDocument(restoring), serializeItemDocument(supplying));
    expect(parseItemDocument(reconciled.merged, { format: "toon" }).metadata).toMatchObject({ deadline: "2027-01-31T00:00:00.000Z" });
    expect(parseItemDocument(reconciled.merged, { format: "toon" }).metadata.deferred_fields).toBeUndefined();

    // A deferral added on one side survives; an entry both sides keep unchanged stays.
    const added = structuredClone(deferredBase);
    added.metadata.deferred_fields = [...(deferredBase.metadata.deferred_fields ?? []), { field: "estimated_minutes", reason: "Unknown size" }];
    const addedMerge = mergeItemDocuments(baseRaw, baseRaw, serializeItemDocument(added));
    expect(parseItemDocument(addedMerge.merged, { format: "toon" }).metadata.deferred_fields?.map((entry) => entry.field)).toEqual(["assignee", "deadline", "estimated_minutes"]);
  });

  it("resolves schema fields mapped to a deferrable key in stdin unsets and template defaults", () => {
    const registry = resolveRuntimeFieldRegistry({ fields: [{ key: "due", metadata_key: "deadline", cli_flag: "due-date", cli_aliases: ["due-on"], type: "string" }] } as never);
    const document = JSON.stringify({ item: { title: "Mirrored", type: "Issue", deferred_fields: [{ field: "deadline", reason: "Imported" }, { field: "assignee", reason: "Imported" }] } });
    for (const token of ["due", "due-date", "due-on"]) {
      expect(itemDocumentToMutationOptions(document, "create", { unset: [token] }, registry.definitions)).toMatchObject({ defer: ["assignee"] });
    }
    expect(_testOnlyCreateCommand.mergeCreateOptionsWithTemplate({ due: "2026-12-31", sprint: "s1" }, { title: "x", defer: ["deadline"] } as never, registry)).not.toHaveProperty("due");
    expect(_testOnlyCreateCommand.mergeCreateOptionsWithTemplate({ due: "2026-12-31" }, { title: "x", defer: ["deadline"], due: "2027-01-01" } as never, registry)).toMatchObject({ due: "2027-01-01" });
  });

  it("lets a deferral override a template default exactly like an unset", () => {
    const template = { deadline: "2026-12-31", assignee: "template-owner", estimatedMinutes: "10" };
    expect(_testOnlyCreateCommand.mergeCreateOptionsWithTemplate(template, { title: "x", defer: ["deadline", "bogus"] } as never)).not.toHaveProperty("deadline");
    expect(_testOnlyCreateCommand.mergeCreateOptionsWithTemplate(template, { title: "x", defer: "assignee,estimate" } as never)).toMatchObject({ deadline: "2026-12-31" });
    expect(_testOnlyCreateCommand.mergeCreateOptionsWithTemplate(template, { title: "x", defer: "assignee,estimate" } as never)).not.toHaveProperty("assignee");
    expect(_testOnlyCreateCommand.mergeCreateOptionsWithTemplate(template, { title: "x", defer: [7] } as never)).toMatchObject({ deadline: "2026-12-31", assignee: "template-owner" });
  });

  it("validates, normalizes and resolves stored deferral entries", () => {
    expect(DEFERRABLE_ITEM_FIELDS.map((entry) => entry.field)).toEqual(["acceptance_criteria", "assignee", "deadline", "estimated_minutes"]);
    expect(resolveDeferrableItemField(" AC ")?.field).toBe("acceptance_criteria");
    expect(resolveDeferrableItemField("estimate")?.option).toBe("estimatedMinutes");
    expect(resolveDeferrableItemField("priority")).toBeUndefined();

    expect(describeInvalidDeferredFields(undefined)).toBeUndefined();
    expect(describeInvalidDeferredFields([{ field: "deadline", reason: "x" }])).toBeUndefined();
    expect(describeInvalidDeferredFields("deadline")).toBe("deferred_fields must be an array");
    expect(describeInvalidDeferredFields(["deadline"])).toBe("deferred_fields[0] must be an object");
    expect(describeInvalidDeferredFields([[]])).toBe("deferred_fields[0] must be an object");
    expect(describeInvalidDeferredFields([{ field: "priority", reason: "x" }])).toMatch(/^deferred_fields\[0\]\.field must be one of/u);
    expect(describeInvalidDeferredFields([{ field: "deadline", reason: " " }])).toBe("deferred_fields[0].reason must be a non-empty string");
    expect(describeInvalidDeferredFields([{ field: "deadline", reason: "a" }, { field: "deadline", reason: "b" }])).toBe("deferred_fields lists deadline more than once");

    expect(normalizeDeferredFields(undefined)).toBeUndefined();
    expect(normalizeDeferredFields([])).toBeUndefined();
    expect(normalizeDeferredFields([{ field: "deadline", reason: " later " }, { field: "assignee", reason: "x" }])).toEqual([
      { field: "assignee", reason: "x" },
      { field: "deadline", reason: "later" },
    ]);

    expect(hasConcreteItemFieldValue({ deadline: " " }, "deadline")).toBe(false);
    expect(hasConcreteItemFieldValue({ estimated_minutes: 0 }, "estimated_minutes")).toBe(true);
    expect(hasConcreteItemFieldValue({ estimated_minutes: Number.NaN }, "estimated_minutes")).toBe(false);
    expect(hasConcreteItemFieldValue({}, "assignee")).toBe(false);
    expect(hasConcreteItemFieldValue({ tags: [] } as Partial<ItemMetadata>, "tags")).toBe(true);
    expect(outstandingDeferredFields({})).toEqual([]);

    const metadata = { deferred_fields: [{ field: "deadline", reason: "x" }, { field: "assignee", reason: "y" }] } as ItemMetadata;
    expect(pruneResolvedDeferredFields({} as ItemMetadata)).toBe(false);
    expect(pruneResolvedDeferredFields(metadata)).toBe(false);
    metadata.deadline = "2026-12-31T00:00:00.000Z";
    expect(pruneResolvedDeferredFields(metadata)).toBe(true);
    expect(metadata.deferred_fields).toEqual([{ field: "assignee", reason: "y" }]);
    metadata.assignee = "alice";
    expect(pruneResolvedDeferredFields(metadata)).toBe(true);
    expect(metadata).not.toHaveProperty("deferred_fields");
  });

  it("bounds the curation rows unless verbose diagnostics are requested", () => {
    const items = Array.from({ length: 7 }, (_, index) => ({ id: `pm-${index}`, deferred_fields: [{ field: "deadline", reason: index % 2 === 0 ? "even" : "odd" }] }));
    expect(summarizeDeferredFieldCuration([{ id: "pm-none" }], false)).toBeUndefined();
    expect(summarizeDeferredFieldCuration(items, false)).toMatchObject({ details: { items: 7, truncated: true, by_field: { deadline: 7 } }, warning: "validate_metadata_deferred_fields:7" });
    expect(summarizeDeferredFieldCuration(items, false)?.details.rows).toHaveLength(5);
    expect(summarizeDeferredFieldCuration(items, true)?.details).toMatchObject({ truncated: false });
    expect(summarizeDeferredFieldCuration(items, true)?.details.rows).toHaveLength(7);
  });
});
