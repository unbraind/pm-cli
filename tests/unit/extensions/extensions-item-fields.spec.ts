import { describe, expect, it } from "vitest";
import {
  applyRegisteredItemFieldDefaultsAndValidation,
  parseRegisteredItemFieldAssignments,
  RESERVED_ITEM_FIELD_NAMES,
} from "../../../src/core/extensions/item-fields.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { createSchemaFieldRecoveryResolver, resolveCoreFieldRecovery } from "../../../src/sdk/lifecycle/core-field-recovery.js";
import { resolveRuntimeFieldRegistry } from "../../../src/core/schema/runtime-schema.js";
import { collectRuntimeUpdateFieldValues } from "../../../src/core/schema/runtime-field-values.js";
import { CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS, UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS } from "../../../src/sdk/cli-contracts/commander-mutation-options.js";
import {
  createEmptyExtensionRegistrationRegistry,
  type ExtensionRegistrationRegistry,
} from "../../../src/core/extensions/loader.js";

function withFields(
  fields: Array<Record<string, unknown>>,
): ExtensionRegistrationRegistry {
  const registrations = createEmptyExtensionRegistrationRegistry();
  registrations.item_fields.push({
    layer: "project",
    name: "test-extension",
    fields,
  });
  return registrations;
}

/** Parse one assignment through the host resolvers and return the refusal it must raise. */
function refuseFieldAssignment(
  raw: string,
  resolveSchemaField: (field: string) => Pick<PmCliError["context"], "recovery" | "nextSteps"> | undefined,
): PmCliError {
  try {
    parseRegisteredItemFieldAssignments([raw], withFields([{ name: "team", type: "string" }]), resolveCoreFieldRecovery, resolveSchemaField);
  } catch (error) {
    return error as PmCliError;
  }
  throw new Error("expected a refusal");
}

describe("extensions item field runtime wiring", () => {
  it.each([["comments", "--comment"], ["type_options", "--type-option"], ["dependencies", "--dep"]] as const)("resolves the actual collection mutation route for %s", (field, flag) => {
    expect(resolveCoreFieldRecovery(field).recovery?.suggested_flags).toContain(flag);
  });
  it.each([...RESERVED_ITEM_FIELD_NAMES])("never invents a mutation flag for reserved core field %s", (field) => {
    let refusal: unknown;
    try {
      parseRegisteredItemFieldAssignments([`${field}=value`], null, resolveCoreFieldRecovery);
    } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(PmCliError);
    const context = (refusal as PmCliError).context;
    expect(context.code).toBe("core_item_field_requires_dedicated_flag");
    const declared = [...CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS, ...UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS].map((contract) => contract.option.match(/--[a-z][a-z0-9-]*/u)![0]);
    for (const flag of context.recovery?.suggested_flags ?? []) expect(declared).toContain(flag);
    if (!context.recovery?.suggested_flags) expect(context.nextSteps?.[0]).toContain("No dedicated create/update CLI mutation flag");
    if (field === "external_ref") expect(context.recovery?.suggested_flags).toBeUndefined();
  });

  it("routes configured project-schema keys to their declared flag and SDK option, keeping extension and core refusals distinct (pm-wftvem)", () => {
    const registry = resolveRuntimeFieldRegistry({
      fields: [
        { key: "gate_evidence", type: "object", commands: ["create", "update"] },
        { key: "reviewUrl", metadata_key: "review_link", type: "string", cli_flag: "review-url", commands: ["update"] },
        { key: "intake_note", type: "string", commands: ["create"] },
        { key: "review_link_alt", type: "string", cli_flag: "review.url", commands: ["update"] },
      ],
    } as never);
    const resolveForUpdate = createSchemaFieldRecoveryResolver(registry, "update");
    const refusal = (raw: string, resolver = resolveForUpdate): PmCliError => refuseFieldAssignment(raw, resolver);
    const gate = refusal('gate_evidence={"disposition":"gate_added"}');
    expect(gate.message).toBe("--field gate_evidence is a project-schema field; set it with its declared flag --gate-evidence");
    expect(gate.context).toEqual({
      code: "project_schema_field_requires_declared_flag",
      field: "gate_evidence",
      changed: false,
      recovery: { provided_fields: ["gate_evidence"], suggested_flags: ["--gate-evidence"] },
      nextSteps: [
        "Use the declared project-schema flag: pm update <id> --gate-evidence <value>",
        "SDK: pass gateEvidence in the update options.",
        "Inspect the value contract with: pm schema show-field gate_evidence",
      ],
    });
    // Storage key and declared key both route; the flag is the declared one, not the key spelling.
    const single = createSchemaFieldRecoveryResolver(resolveRuntimeFieldRegistry({
      fields: [{ key: "reviewUrl", metadata_key: "review_link", type: "string", cli_flag: "review-url", commands: ["update"] }],
    } as never), "update");
    for (const key of ["review_link", "reviewUrl"]) {
      expect(refusal(`${key}=https://example.test`, single).context.recovery?.suggested_flags).toEqual(["--review-url"]);
    }
    expect(refusal("review_link=x", single).context.nextSteps?.[1]).toBe("SDK: pass reviewUrl in the update options.");
    const createOnly = refusal("intake_note=hello");
    expect(createOnly.message).toBe("--field intake_note is a project-schema field, not an extension field");
    expect(createOnly.context.recovery).toEqual({ provided_fields: ["intake_note"] });
    expect(createOnly.context.nextSteps?.[0]).toBe('The project schema declares "intake_note" for create only; update cannot set it.');
    expect(refusal("intake_note=hello", createSchemaFieldRecoveryResolver(registry, "create")).context.nextSteps?.[0]).toBe(
      "Use the declared project-schema flag: pm create --intake-note <value>",
    );
    // Undeclared keys keep the extension refusal; reserved core keys keep theirs.
    expect(refusal("unknown_key=1").context.code).toBe("extension_item_field_unknown");
    expect(refusal("status=closed").context.code).toBe("core_item_field_requires_dedicated_flag");
    // A declared extension field still admits normally.
    expect(parseRegisteredItemFieldAssignments(["team=platform"], withFields([{ name: "team", type: "string" }]), resolveCoreFieldRecovery, resolveForUpdate)).toEqual({ team: "platform" });
  });

  it("advertises only CLI flags and SDK options that set the refused schema field alone (pm-wftvem)", () => {
    const registry = resolveRuntimeFieldRegistry({
      fields: [
        { key: "gate_evidence", type: "object", commands: ["create", "update"] },
        { key: "reviewUrl", metadata_key: "review_link", type: "string", cli_flag: "review-url", commands: ["update"] },
        { key: "review_link_alt", type: "string", cli_flag: "review.url", commands: ["update"] },
      ],
    } as never);
    const resolveForUpdate = createSchemaFieldRecoveryResolver(registry, "update");
    const refusal = (raw: string, resolver = resolveForUpdate): PmCliError => refuseFieldAssignment(raw, resolver);
    // --review-url parses to reviewUrl, which review_link_alt also reads (review.url normalizes to it), so that
    // flag is never advertised; Commander keeps --review.url as the literal key "review.url", which only
    // review_link_alt reads, so its flag is.
    const ambiguous = refusal("review_link=x");
    expect(ambiguous.context.recovery).toEqual({ provided_fields: ["review_link"] });
    expect(ambiguous.message).toBe("--field review_link is a project-schema field, not an extension field");
    expect(ambiguous.context.nextSteps?.[0]).toContain("is shared with another declared field or an option of pm update");
    expect(refusal("review_link_alt=x").context.recovery?.suggested_flags).toEqual(["--review.url"]);
    expect(Object.keys(collectRuntimeUpdateFieldValues({ "review.url": "x" }, registry))).toEqual(["review_link_alt"]);
    expect(refusal("review_link=x").context.nextSteps?.[1]).toBe("SDK: pass reviewurl in the update options.");
    expect(refusal("review_link_alt=x").context.nextSteps?.[1]).toBe("SDK: pass reviewLinkAlt in the update options.");
    for (const [field, option] of [["review_link", "reviewurl"], ["review_link_alt", "reviewLinkAlt"], ["gate_evidence", "gateEvidence"]] as const) {
      const value = field === "gate_evidence" ? { disposition: "gate_added" } : "https://example.test";
      expect(Object.keys(collectRuntimeUpdateFieldValues({ [option]: value }, registry))).toEqual([field]);
    }
    // A flag that a core option owns (--title) is never advertised; an alias or the key-derived SDK option is.
    const coreNamed = resolveRuntimeFieldRegistry({
      fields: [{ key: "review_heading", type: "string", cli_flag: "title", cli_aliases: ["review-heading"], commands: ["update"] }],
    } as never);
    const heading = refusal("review_heading=x", createSchemaFieldRecoveryResolver(coreNamed, "update"));
    expect(heading.context.recovery?.suggested_flags).toEqual(["--review-heading"]);
    expect(heading.context.nextSteps?.[1]).toBe("SDK: pass reviewHeading in the update options.");
    expect(Object.keys(collectRuntimeUpdateFieldValues({ reviewHeading: "x" }, coreNamed))).toEqual(["review_heading"]);
    // When declarations share a storage key, the route goes through one the command may set.
    const sharedKey = resolveRuntimeFieldRegistry({
      fields: [
        { key: "triage_a", metadata_key: "triage", type: "string", commands: ["create"] },
        { key: "triage_b", metadata_key: "triage", type: "string", commands: ["update"] },
      ],
    } as never);
    expect(refusal("triage=x", createSchemaFieldRecoveryResolver(sharedKey, "update")).context.recovery?.suggested_flags).toEqual(["--triage-b"]);
    // Declarations sharing a storage key are still distinct readers: identical flag spellings are ambiguous.
    const twins = resolveRuntimeFieldRegistry({
      fields: [
        { key: "triage_c", metadata_key: "triage2", type: "string", cli_flag: "triage-two", commands: ["update"] },
        { key: "triage_d", metadata_key: "triage2", type: "number", cli_flag: "triage.two", commands: ["update"] },
      ],
    } as never);
    expect(refusal("triage2=1", createSchemaFieldRecoveryResolver(twins, "update")).context.nextSteps?.[1]).toBe("SDK: pass triageC in the update options.");
    // When every name a field answers to is shared, no SDK option is advertised.
    const sharedOnly = resolveRuntimeFieldRegistry({
      fields: [
        { key: "x_y", type: "string", commands: ["update"] },
        { key: "xy", type: "string", cli_flag: "x.y", commands: ["update"] },
      ],
    } as never);
    const allShared = refusal("x_y=1", createSchemaFieldRecoveryResolver(sharedOnly, "update"));
    expect(allShared.context.recovery).toEqual({ provided_fields: ["x_y"] });
    expect(allShared.context.nextSteps?.[1]).toContain("every option name for this field is shared");
  });

  it("keeps the standalone core parser truthful without host command contracts", () => {
    expect(() => parseRegisteredItemFieldAssignments(["external_ref=GH-1"], null)).toThrowError(expect.objectContaining({
      context: expect.objectContaining({
        recovery: { provided_fields: ["external_ref"] },
        nextSteps: [expect.stringContaining("no generic --field mutation path")],
      }),
    }));
  });
  it("applies defaults and validates values when registrations are present", () => {
    const itemMetadata: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(
      itemMetadata,
      withFields([
        { name: "team", type: "string", default: "platform" },
        { name: "size", type: "number", default: 3 },
      ]),
    );
    expect(itemMetadata).toEqual({
      team: "platform",
      size: 3,
    });
  });

  it("does nothing when registrations are absent", () => {
    const itemMetadata: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(itemMetadata, null);
    expect(itemMetadata).toEqual({});
  });

  it("parses declared extension field assignments with typed values", () => {
    const parsed = parseRegisteredItemFieldAssignments(
      [
        "text_value=hello",
        "number_value=42",
        "boolean_value=yes",
        "string_array_value=alpha, beta | gamma",
        'array_value=["a","b"]',
        'object_value={"key":"value"}',
      ],
      withFields([
        { name: "text_value", type: "string" },
        { name: "number_value", type: "number" },
        { name: "boolean_value", type: "boolean" },
        { name: "string_array_value", type: "string_array" },
        { name: "array_value", type: "array" },
        { name: "object_value", type: "object" },
      ]),
    );

    expect(parsed).toEqual({
      text_value: "hello",
      number_value: 42,
      boolean_value: true,
      string_array_value: ["alpha", "beta", "gamma"],
      array_value: ["a", "b"],
      object_value: { key: "value" },
    });
  });

  it("rejects undeclared and invalid typed extension field assignments", () => {
    const registrations = withFields([
      { name: "count", type: "number" },
      { name: "enabled", type: "boolean" },
      { name: "payload", type: "object" },
    ]);

    expect(() =>
      parseRegisteredItemFieldAssignments(["missing=value"], registrations),
    ).toThrowError(expect.objectContaining({
      message: "--field missing is not declared by an active extension item-field registration",
      context: expect.objectContaining({
        code: "extension_item_field_unknown",
        field: "missing",
        recovery: { provided_fields: ["missing"] },
        nextSteps: ["Use one of the declared fields: count, enabled, payload"],
      }),
    }));
    expect(() =>
      parseRegisteredItemFieldAssignments(["count=NaN"], registrations),
    ).toThrow("must be a number");
    expect(() =>
      parseRegisteredItemFieldAssignments(["count=   "], registrations),
    ).toThrow("must be a number");
    expect(() =>
      parseRegisteredItemFieldAssignments(["enabled=maybe"], registrations),
    ).toThrow("true|false");
    expect(() =>
      parseRegisteredItemFieldAssignments(["payload=not-json"], registrations),
    ).toThrow("valid JSON object");
  });

  it("rejects assignments missing the name=value separator", () => {
    expect(() =>
      parseRegisteredItemFieldAssignments(
        ["=value"],
        withFields([{ name: "count", type: "number" }]),
      ),
    ).toThrow("--field entries must use name=value syntax");
  });

  it("rejects conflicting extension field types for the same field name", () => {
    expect(() =>
      parseRegisteredItemFieldAssignments(
        ["github_number=7"],
        withFields([
          { name: "github_number", type: "number" },
          { name: "github_number", type: "string" },
        ]),
      ),
    ).toThrow(
      'Extension item field "github_number" is declared with conflicting types: number, string',
    );

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        {},
        withFields([
          { name: "github_number", type: "number" },
          { name: "github_number", type: "string" },
        ]),
      ),
    ).toThrow(
      'Extension item field "github_number" is declared with conflicting types: number, string',
    );
  });

  it("accepts supported field types", () => {
    const itemMetadata: Record<string, unknown> = {
      text_value: "ok",
      number_value: 1,
      boolean_value: true,
      string_array_value: ["a"],
      array_value: ["a"],
      object_value: { key: "value" },
    };
    applyRegisteredItemFieldDefaultsAndValidation(
      itemMetadata,
      withFields([
        { name: "text_value", type: "string" },
        { name: "number_value", type: "number" },
        { name: "boolean_value", type: "boolean" },
        { name: "string_array_value", type: "string_array" },
        { name: "array_value", type: "array" },
        { name: "object_value", type: "object" },
      ]),
    );
    expect(itemMetadata.object_value).toEqual({ key: "value" });
  });

  it("throws for type mismatch and allowed value mismatch", () => {
    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        { ext_severity: "high" },
        withFields([{ name: "ext_severity", type: "number" }]),
      ),
    ).toThrow('Item field "ext_severity" must be of type number');

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        { labels: ["valid", 1] },
        withFields([{ name: "labels", type: "string_array" }]),
      ),
    ).toThrow('Item field "labels" must be of type string_array');

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        { ext_status: "blocked" },
        withFields([
          { name: "ext_status", type: "string", values: ["open", "closed"] },
        ]),
      ),
    ).toThrow(
      'Item field "ext_status" must match one of the configured allowed values',
    );
  });

  it("rejects extension field names that collide with reserved metadata", () => {
    expect(() =>
      parseRegisteredItemFieldAssignments(
        ["id=pm-other"],
        withFields([{ name: "id", type: "string" }]),
      ),
    ).toThrow(
      'Extension item field "id" collides with built-in item metadata "id"',
    );

    expect(() =>
      applyRegisteredItemFieldDefaultsAndValidation(
        {},
        withFields([
          {
            name: "updated_at",
            type: "string",
            default: "2026-01-01T00:00:00.000Z",
          },
        ]),
      ),
    ).toThrow(
      'Extension item field "updated_at" collides with built-in item metadata "updated_at"',
    );
  });

  it("skips invalid field names and unknown field types", () => {
    const itemMetadata: Record<string, unknown> = { tracked: 42 };
    applyRegisteredItemFieldDefaultsAndValidation(
      itemMetadata,
      withFields([
        { name: "   ", default: "ignored" },
        { name: "tracked", type: "nonsense-type" },
      ]),
    );
    expect(itemMetadata).toEqual({ tracked: 42 });
  });

  it("clones cloneable defaults and preserves non-cloneable defaults", () => {
    const objectDefault = { nested: { value: 1 } };
    const functionDefault = () => "fallback";
    const itemMetadata: Record<string, unknown> = {};
    applyRegisteredItemFieldDefaultsAndValidation(
      itemMetadata,
      withFields([
        { name: "object_default", default: objectDefault },
        { name: "function_default", default: functionDefault },
      ]),
    );

    expect(itemMetadata.object_default).toEqual({ nested: { value: 1 } });
    expect(itemMetadata.object_default).not.toBe(objectDefault);
    expect(itemMetadata.function_default).toBe(functionDefault);
  });
});
