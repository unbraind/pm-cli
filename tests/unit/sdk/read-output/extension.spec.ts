import { afterEach, describe, expect, it } from "vitest";
import { Command } from "commander";
import { recordCliReadOutputInvocationProvenance } from "../../../../src/cli/runtime/invocation-options.js";
import { setActiveExtensionRegistrations } from "../../../../src/core/extensions/index.js";
import { normalizeExtensionReadOutput } from "../../../../src/core/extensions/read-output-contract.js";
import { attachExtensionReadOutputRows, resolveExtensionReadOutput } from "../../../../src/sdk/read-output/extension.js";
import { attachReadOutputContracts } from "../../../../src/sdk/context-intent-contracts.js";
import type { PmReadOutputReceipt, PmReadOutputBudgetExceeded, PmReadOutputTruncationDisclosure } from "../../../../src/sdk/read-output-contracts.js";
import type { ReadRowContract } from "../../../../src/sdk/output-projection.js";
import { decodeReadOutputContinuationCursor, resolveReadOutputSurface, validateReadOutputOptions } from "../../../../src/sdk/read-output-contracts.js";
import { activateSyntheticExtensions } from "../../../helpers/extensions.js";

interface FixtureOutput {
  payload: { rows: Array<Record<string, unknown>> };
  count: number;
  total: number;
  read_output: PmReadOutputReceipt;
  row_contract: ReadRowContract;
  output_budget_truncation: PmReadOutputTruncationDisclosure;
}


afterEach(() => setActiveExtensionRegistrations(null));

describe("extension read-output declarations", () => {
  it("retains absent metadata and allows an explicitly declared singleton", () => {
    expect(normalizeExtensionReadOutput(undefined)).toBeUndefined();
    expect(normalizeExtensionReadOutput({ row_keys: [] })).toEqual({ row_keys: [] });
    expect(() => normalizeExtensionReadOutput({ row_keys: [] }, "create")).toThrow("Native pm");
    expect(() => normalizeExtensionReadOutput({ row_keys: [] }, "list")).toThrow("Native pm");
    expect(() => normalizeExtensionReadOutput({ row_keys: [] }, "probe", "list")).toThrow("Native pm");
    expect(() => normalizeExtensionReadOutput({ row_keys: [] }, "comments-audit")).toThrow("Native pm");
    expect(() => normalizeExtensionReadOutput({ row_keys: Array(1) })).toThrow("safe dot-delimited");
  });
  it.each([null, [], {}, { row_keys: [], typo: true }, { row_keys: [1] }, { row_keys: ["a..b"] }, { row_keys: ["__proto__.rows"] }, { row_keys: ["row_contract"] }, { row_keys: ["rows", "rows"] }, { row_keys: ["rows", "rows.child"] }])("rejects invalid declaration %j", (value) => {
    expect(() => normalizeExtensionReadOutput(value)).toThrow();
  });

  it("snapshots package metadata and shapes nested rows with command-bound continuation", async () => {
    const rowKeys = ["payload.rows"];
    const activation = await activateSyntheticExtensions([{
      name: "read-probe", capabilities: ["commands"], activate(api) {
        api.registerCommand({ name: "probe rows", action: "probe-read", read_output: { row_keys: rowKeys }, run: () => ({}) });
        api.registerCommand({ name: "probe write", run: () => ({}) });
        api.registerCommand({ name: "list probe", read_output: { row_keys: ["items"] }, run: () => ({}) });
        api.registerCommand({ name: "list writer", run: () => ({}) });
        api.registerCommand({ name: "probe alias", action: "probe-read", read_output: { row_keys: ["alternate_rows"] }, run: () => ({}) });
        api.registerCommand({ name: "probe overridden", action: "old-reader", read_output: { row_keys: [] }, run: () => ({}) });
        api.registerCommand({ name: "probe overridden", action: "new-writer", run: () => ({}) });
      },
    }]);
    setActiveExtensionRegistrations(activation.registrations);
    rowKeys.push("unregistered");
    expect(resolveExtensionReadOutput("probe-read")?.command).toBe("probe rows");
    expect(resolveExtensionReadOutput("probe alias")?.command).toBe("probe alias");
    expect(resolveExtensionReadOutput("old-reader")).toBeUndefined();
    expect(resolveExtensionReadOutput("new-writer")).toBeUndefined();
    expect(resolveReadOutputSurface("probe-read")).toBe("extension:probe rows");
    expect(resolveReadOutputSurface("probe rows")).toBe("extension:probe rows");
    expect(resolveReadOutputSurface("list probe")).toBe("extension:list probe");
    expect(resolveReadOutputSurface("list-probe")).toBe("extension:list probe");
    expect(resolveReadOutputSurface("list")).toBe("list");
    expect(resolveReadOutputSurface("comments-audit")).toBe("comments-audit");
    const program = new Command("pm");
    program.rawArgs = ["node", "pm", "probe", "rows", "--output-limit", "2"];
    const leaf = program.command("probe").command("rows");
    const cliOptions = { outputLimit: 2 };
    recordCliReadOutputInvocationProvenance(leaf, "probe rows", cliOptions);
    expect(attachReadOutputContracts("probe rows", { ...cliOptions, outputBudget: "unbounded" }, { payload: { rows: [{id:"a"}, {id:"b"}, {id:"c"}] }, count:3 })).toMatchObject({count:2,read_output:{command:"extension:probe rows"}});
    expect(() => validateReadOutputOptions("list writer", { outputLimit: 1 })).toThrow("only to read");
    expect(() => validateReadOutputOptions("list-writer", { outputLimit: 1 })).toThrow("only to read");
    expect(resolveExtensionReadOutput("create")).toBeUndefined();
    expect(() => validateReadOutputOptions("create", { outputBudget: 500 })).toThrow("only to read");
    expect(() => validateReadOutputOptions("probe write", { outputLimit: 1 })).toThrow("only to read");
    const original = { payload: { rows: Array.from({ length: 5 }, (_, i) => ({ id: `row-${i}`, title: "retain", private: "omit" })) }, count: 5, total: 5 };
    const output = attachReadOutputContracts("probe-read", { outputInclude: "id,title", outputLimit: 2, outputBudget: "unbounded", outputRowContract: true }, original) as FixtureOutput;
    expect(output.payload.rows).toEqual(original.payload.rows.slice(0, 2).map(({ id, title }) => ({ id, title })));
    expect(output.count).toBe(2);
    expect(output.total).toBe(5);
    expect(output.read_output.command).toBe("extension:probe rows");
    expect(output.row_contract.row_keys).toEqual(["payload.rows"]);
    expect(original.payload.rows).toHaveLength(5);
    const bounded = attachReadOutputContracts("probe rows", { outputBudget: 1 }, original) as PmReadOutputBudgetExceeded;
    expect(bounded.output_budget_exceeded.reason).toBe("requested_budget_infeasible");
    const large = { payload: { rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, detail: "x".repeat(500) })) }, count: 200, total: 200 };
    const page = attachReadOutputContracts("probe rows", { outputBudget: 1500 }, large) as FixtureOutput;
    expect(page.output_budget_truncation.continuations[0].path).toBe("payload.rows");
    const cursor = page.output_budget_truncation.continuations[0].cursor;
    const resumed = attachReadOutputContracts("probe-read", { outputCursor: cursor, outputBudget: "unbounded" }, large) as FixtureOutput;
    expect(resumed.payload.rows[0].id).toBe(`row-${page.payload.rows.length}`);
    expect(() => attachReadOutputContracts("probe rows", { outputCursor: cursor }, { ...large, payload: { rows: [...large.payload.rows, { id: "added", detail: "new" }] } })).toThrow("no longer matches");
    const keys = resolveExtensionReadOutput("probe rows")?.read_output?.row_keys;
    expect(Object.isFrozen(keys)).toBe(true);
    setActiveExtensionRegistrations(null);
    expect(decodeReadOutputContinuationCursor(cursor).command).toBe("extension:probe rows");
  });

  it("keeps native mutators closed to host-assembled alias declarations", async () => {
    const activation = await activateSyntheticExtensions([{ name: "host", capabilities: ["commands"], activate(api) {
      api.registerCommand({ name: "probe read", read_output: { row_keys: [] }, run: () => ({}) });
    } }]);
    activation.registrations.commands.push({ ...activation.registrations.commands[0]!, command: "create", action: "alternate-create" });
    setActiveExtensionRegistrations(activation.registrations);
    expect(attachReadOutputContracts("probe read", { outputBudget: "unbounded", outputRowContract: true }, { ok: true })).toMatchObject({ ok: true, row_contract: { row_kind: "none", row_keys: [] } });
    expect(resolveExtensionReadOutput("alternate-create")).toBeUndefined();
    expect(() => validateReadOutputOptions("alternate-create", { outputLimit: 1 })).toThrow("only to read");
  });

  it("refuses nonstructured or missing declared rows while retaining undeclared results", async () => {
    const activation = await activateSyntheticExtensions([{ name: "results", capabilities: ["commands"], activate(api) {
      api.registerCommand({ name: "probe", read_output: { row_keys: ["rows"] }, run: () => ({}) });
    } }, { name: "bad-results", capabilities: ["commands"], activate(api) {
      api.registerCommand({ name: "invalid", read_output: { row_keys: ["constructor"] }, run: () => ({}) });
    } }]);
    expect(activation.failed).toHaveLength(1);
    setActiveExtensionRegistrations(activation.registrations);
    for (const result of [null, [], "text"]) expect(() => attachExtensionReadOutputRows("probe", result)).toThrow("structured object");
    for (const result of [{}, { rows: null }, { rows: 5 }]) expect(() => attachExtensionReadOutputRows("probe", result)).toThrow("declared row collection rows");
    expect(attachExtensionReadOutputRows("undeclared", "text")).toBe("text");
    expect(attachExtensionReadOutputRows("probe", { rows: { key: { title: "mapped" } } })).toMatchObject({ row_contract: { row_keys: ["rows"] } });
  });
});
