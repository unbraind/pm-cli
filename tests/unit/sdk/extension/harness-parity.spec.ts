/**
 * pm-gh1727 / pm-gh1729 (Codex review round 1): the extension test harness
 * admits what native dispatch admits. An extension that extends a native
 * command still receives the native command's options, and read-output
 * admission judges the result after a registered command-result override.
 */
import { describe, expect, it } from "vitest";
import { activateExtensionForTest, runRegisteredCommandForTest } from "../../../../src/sdk/testing.js";
import { suppressHostOutput } from "../../../../src/sdk/output.js";
import type { ExtensionApi } from "../../../../src/core/extensions/extension-types.js";

async function activate(register: (api: ExtensionApi) => void) {
  const activation = await activateExtensionForTest({ activate: register }, { name: "harness-parity", capabilities: ["commands", "schema"] });
  expect(activation.failed).toEqual([]);
  return activation;
}

describe("extension test harness parity with native dispatch", () => {
  it("passes a native command's own options to an extension that extends it, and still refuses undeclared keys", async () => {
    const activation = await activate((api) => {
      api.registerFlags("list", [{ long: "--probe", value_type: "boolean" }]);
      api.registerCommand({ name: "list", run: (context) => ({ options: context.options }) });
    });
    const result = await runRegisteredCommandForTest(activation.commands, { command: "list", options: { all: true, status: "open", "--limit": 2, probe: "true" } });
    expect(result).toMatchObject({ handled: true, result: { options: { all: true, status: "open", "--limit": 2, probe: true } } });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "list", options: { typo: 1 } })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "unknown_option", flag: "--typo" }),
    });
  });

  it("admits the result a command-result override delivers, not the raw handler result", async () => {
    const activation = await activate((api) => {
      api.registerFlags("rows-added", [{ long: "--note", value_type: "string" }]);
      api.registerFlags("rows-removed", [{ long: "--note", value_type: "string" }]);
      api.registerFlags("rows-suppressed", [{ long: "--note", value_type: "string" }]);
      for (const name of ["rows-added", "rows-removed", "rows-suppressed"]) {
        api.registerCommand({ name, read_output: { row_keys: ["rows"] }, run: () => (name === "rows-added" ? { ok: true } : { ok: true, rows: [] }) });
      }
      api.registerCommand("rows-added", (context) => ({ ...(context.result as object), rows: [] }));
      api.registerCommand("rows-removed", () => ({ ok: true }));
      api.registerCommand("rows-suppressed", () => suppressHostOutput());
    });
    // The handler omits rows, the override supplies them: native output admits the overridden result.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "rows-added" })).resolves.toMatchObject({ handled: true, result: { ok: true } });
    // The handler returns rows, the override drops them: native output refuses it, and so does the harness.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "rows-removed" })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "extension_read_output_invalid" }),
    });
    // An override that suppresses host output renders nothing, so nothing is admitted.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "rows-suppressed" })).resolves.toMatchObject({ handled: true });
  });
});
