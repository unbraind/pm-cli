import { describe, expect, it } from "vitest";
import {
  PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  definePmCommandOutputEnvelope,
  isPmMutationReceipt,
  parseMutationReceipt,
  resolvePmCommandOutputEnvelope,
} from "../../../src/sdk/index.js";

describe("SDK output envelope contracts", () => {
  it("declares every built-in command and generates conservative package fallbacks", () => {
    expect(PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS).toHaveLength(
      PM_CORE_COMMAND_NAMES.length,
    );
    expect(resolvePmCommandOutputEnvelope("create")).toMatchObject({
      kind: "mutation_receipt",
      wrapper_key: null,
      cardinality: "one",
      format_flag: "--json",
    });
    expect(resolvePmCommandOutputEnvelope("get")).toMatchObject({
      kind: "entity",
      wrapper_key: "item",
    });
    expect(resolvePmCommandOutputEnvelope("search")).toMatchObject({
      kind: "collection",
      wrapper_key: "items",
    });
    expect(resolvePmCommandOutputEnvelope("acme report")).toMatchObject({
      command: "acme report",
      kind: "diagnostic",
    });
    expect(
      definePmCommandOutputEnvelope({
        command: "acme report",
        kind: "collection",
        wrapper_key: "rows",
        cardinality: "many",
        format_flag: "--json",
      }),
    ).toMatchObject({ command: "acme report", wrapper_key: "rows" });
    expect(() => resolvePmCommandOutputEnvelope(" ")).toThrow(
      "command must be a non-empty command path",
    );
    expect(() =>
      definePmCommandOutputEnvelope({
        command: " ",
        kind: "diagnostic",
        wrapper_key: null,
        cardinality: "none",
        format_flag: "--json",
      }),
    ).toThrow("command must be a non-empty command path");
    expect(() =>
      definePmCommandOutputEnvelope({
        command: "acme invalid",
        kind: "invalid" as never,
        wrapper_key: null,
        cardinality: "none",
        format_flag: "--json",
      }),
    ).toThrow("Unsupported output envelope kind");
  });

  it("parses the real flat mutation receipt into SDK naming", () => {
    const raw = {
      id: "pm-demo",
      status: "closed",
      changed_field_count: 4,
      close_reason: "Done",
      previous_status: "open",
      deleted: false,
      warnings: ["example"],
    };
    expect(isPmMutationReceipt(raw)).toBe(true);
    expect(parseMutationReceipt(JSON.stringify(raw))).toEqual({
      id: "pm-demo",
      status: "closed",
      changedFieldCount: 4,
      closeReason: "Done",
      previousStatus: "open",
      deleted: false,
      warnings: ["example"],
    });
    expect(
      parseMutationReceipt({
        id: "pm-minimal",
        status: "open",
        changed_field_count: 0,
      }),
    ).toEqual({
      id: "pm-minimal",
      status: "open",
      changedFieldCount: 0,
    });
  });

  it.each([
    { item: { id: "pm-wrapped", status: "open" }, changed_field_count: 1 },
    { id: "", status: "open", changed_field_count: 1 },
    { id: "pm-demo", status: "open", changed_field_count: -1 },
    {
      id: "pm-demo",
      status: "open",
      changed_field_count: 1,
      deleted: "yes",
    },
  ])("rejects non-receipt shape %#", (value) => {
    expect(isPmMutationReceipt(value)).toBe(false);
    expect(() => parseMutationReceipt(value)).toThrow(
      "Mutation receipt must be a flat object",
    );
  });

  it("rejects malformed JSON with boundary context", () => {
    expect(() => parseMutationReceipt("{")).toThrow(
      "Mutation receipt must be valid JSON",
    );
  });
});
