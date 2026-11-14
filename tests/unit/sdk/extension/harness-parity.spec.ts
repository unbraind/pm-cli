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
  const activation = await activateExtensionForTest({ activate: register }, { name: "harness-parity", capabilities: ["commands", "schema", "services"] });
  expect(activation.failed).toEqual([]);
  return activation;
}

describe("extension test harness parity with native dispatch", () => {
  it("passes every undeclared key through on a native command path an extension extends, while still refusing on its own commands", async () => {
    const activation = await activate((api) => {
      api.registerFlags("list", [{ long: "--probe", value_type: "boolean" }]);
      api.registerCommand({ name: "list", run: (context) => ({ options: context.options }) });
      api.registerCommand({ name: "probe-own", flags: [{ long: "--probe", value_type: "boolean" }], run: (context) => ({ options: context.options }) });
    });
    // The native contract owns aliases, negated flags and runtime fields there (Codex review rounds 1-3).
    const result = await runRegisteredCommandForTest(activation.commands, {
      command: "list",
      options: { all: true, status: "open", "--limit": 2, probe: "true", truncate: false, tags: "a", storyPoints: 3 },
    });
    expect(result).toMatchObject({ handled: true, result: { options: { all: true, status: "open", "--limit": 2, probe: true, truncate: false, tags: "a", storyPoints: 3 } } });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "probe-own", options: { storyPoints: 3 } })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "unknown_option", flag: "--story-points" }),
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

  it("admits a structured output_format replacement in place of the result, as native output does (Codex review round 2)", async () => {
    const seen: string[] = [];
    const activation = await activate((api) => {
      api.registerFlags("svc-structured", [{ long: "--note", value_type: "string" }]);
      api.registerFlags("svc-string", [{ long: "--note", value_type: "string" }]);
      api.registerCommand({ name: "svc-structured", read_output: { row_keys: ["rows"] }, run: () => ({ ok: true }) });
      api.registerCommand({ name: "svc-string", read_output: { row_keys: ["rows"] }, run: () => ({ ok: true }) });
      api.registerService("output_format", (context) => {
        const payload = context.payload as { format: string };
        seen.push(`${context.command}:${payload.format}`);
        if (context.command === "svc-structured") return { handled: true, result: { ok: true, rows: [] } };
        return { handled: true, result: "receipt.md" };
      });
    });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "svc-structured" })).resolves.toMatchObject({ handled: true });
    // A string rendering does not replace the result, so the receipt-only result is still refused.
    await expect(runRegisteredCommandForTest(activation.commands, { command: "svc-string", global: { json: false } })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "extension_read_output_invalid" }),
    });
    // The fallback encoding follows native formatOutput: TOON unless --json or a JSON workspace default (Codex review round 9).
    for (const defaultOutputFormat of ["toon", "json"] as const) {
      await runRegisteredCommandForTest(activation.commands, { command: "svc-structured", global: { json: undefined, defaultOutputFormat } });
    }
    expect(seen).toEqual(["svc-structured:json", "svc-string:toon", "svc-structured:toon", "svc-structured:json"]);
    // A registry copied without the service symbol admits the result itself.
    const copied = { ...activation.commands };
    Object.defineProperty(copied, Symbol.for("pm.sdk.testing.activatedFlagRegistrations"), { value: activation.registrations });
    await expect(runRegisteredCommandForTest(copied, { command: "svc-structured" })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "extension_read_output_invalid" }),
    });
  });

  it("names an inline declaration's flag token alone in missing-option metadata (Codex review round 2)", async () => {
    const activation = await activate((api) => {
      api.registerFlags("inline-required", [
        { long: "--from-tracker <path>", required: true },
        { long: "--mode [kind]", required: true },
      ]);
      api.registerCommand({ name: "inline-required", run: () => ({ ok: true }) });
    });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "inline-required", options: { mode: "x" } })).rejects.toMatchObject({
      context: expect.objectContaining({
        code: "missing_required_option",
        flag: "--from-tracker",
        field: "fromTracker",
        examples: ["pm inline-required --from-tracker <path>"],
        recovery: { missing: ["--from-tracker"] },
      }),
    });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "inline-required", options: { fromTracker: "x" } })).rejects.toMatchObject({
      context: expect.objectContaining({ flag: "--mode", examples: ["pm inline-required --mode [kind]"] }),
    });
  });

  it("honours an explicit output encoding when it runs output_format before admission (Codex review round 3)", async () => {
    const activation = await activate((api) => {
      api.registerFlags("svc-toon", [{ long: "--note", value_type: "string" }]);
      api.registerCommand({ name: "svc-toon", read_output: { row_keys: ["rows"] }, run: () => ({ ok: true }) });
      api.registerService("output_format", (context) => {
        const payload = context.payload as { format: string; command_options: Record<string, unknown> };
        // Native output hands the service the merged command options with the resolved encoding (Codex review round 5).
        const options = (context.payload as { options: { commandArgs: string[]; pmRoot?: string; command: string } }).options;
        // ...and the dispatch metadata native output passes: command, commandArgs, pmRoot (Codex review round 6),
        // plus the portable workspace coordinates native dispatch resolves (Codex review round 7).
        return payload.format === "toon" && payload.command_options.resolvedOutputFormat === "toon" && payload.command_options.outputFormat === "toon" &&
          options.command === "svc-toon" && options.commandArgs[0] === "arg-1" && options.pmRoot === "/tracker" &&
          typeof context.source_workspace_root === "string"
          ? { handled: true, result: { ok: true, rows: [] } }
          : { handled: false };
      });
    });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "svc-toon", args: ["arg-1"], pmRoot: "/tracker", options: { outputFormat: "toon" } })).resolves.toMatchObject({ handled: true });
    // A global output control wins over the JSON default too (Codex review round 4).
    await expect(runRegisteredCommandForTest(activation.commands, { command: "svc-toon", args: ["arg-1"], pmRoot: "/tracker", global: { outputFormat: "toon" } })).resolves.toMatchObject({ handled: true });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "svc-toon" })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "extension_read_output_invalid" }),
    });
  });

  it("keeps package-owned compatibility paths under the strict policy, unlike core paths (Codex review round 8)", async () => {
    const activation = await activate((api) => {
      api.registerCommand({ name: "guide", flags: [{ long: "--topic", value_type: "string" }], run: (context) => ({ options: context.options }) });
    });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "guide", options: { typoKey: "x" } })).rejects.toMatchObject({
      context: expect.objectContaining({ code: "unknown_option", flag: "--typo-key" }),
    });
  });

  it("admits the mutation-receipt projection native printResult applies before overrides (Codex review round 8)", async () => {
    const activation = await activate((api) => {
      api.registerFlags("probe-id", [{ long: "--note", value_type: "string" }]);
      api.registerCommand({ name: "probe-id", read_output: { row_keys: ["rows"] }, run: () => ({ item: { id: "pm-x", status: "open" } }) });
      api.registerService("output_format", (context) => {
        const result = (context.payload as { result: Record<string, unknown> }).result;
        return result.id === "pm-x" ? { handled: true, result: { rows: [{ id: result.id }] } } : { handled: false };
      });
    });
    await expect(runRegisteredCommandForTest(activation.commands, { command: "probe-id", global: { idOnly: true } })).resolves.toMatchObject({ handled: true });
    for (const global of [{}, { fullChangedFields: true }, { noChangedFields: true }]) {
      await expect(runRegisteredCommandForTest(activation.commands, { command: "probe-id", global })).rejects.toMatchObject({
        context: expect.objectContaining({ code: "extension_read_output_invalid" }),
      });
    }
  });
});

