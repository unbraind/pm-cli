import { describe, expect, it } from "vitest";
import { repairProjectionRecovery } from "../../../../src/cli/runtime/projection-retry.js";
import { repairSchemaFieldRecovery } from "../../../../src/cli/runtime/field-route-retry.js";

describe("minimal projection retry edits", () => {
  it("preserves scope, encoding, filters, literal operands and shell quoting", () => {
    const invocation = ["--pm-path=/tracker with spaces/$literal", "search", "--fields=title,typo", "--output-format", "json", "--tag", "scope", "--limit", "7", "--", "--full"];
    const result = repairProjectionRecovery(invocation, "unknown_field_projection", { suggested_retry_args: ["search", "ignored generic operand", "--fields", "title"] });
    const expected = ["--pm-path=/tracker with spaces/$literal", "search", "--fields", "title", "--output-format", "json", "--tag", "scope", "--limit", "7", "--", "--full"];
    expect(result?.suggested_retry_args).toEqual(expected);
    expect(result?.suggested_retry).toBe(process.platform === "win32"
      ? 'pm "--pm-path=/tracker with spaces/$literal" search --fields title --output-format json --tag scope --limit 7 -- --full'
      : 'pm "--pm-path=/tracker with spaces/\\$literal" search --fields title --output-format json --tag scope --limit 7 -- --full');
    expect(invocation[2]).toBe("--fields=title,typo");
  });

  it.each(["--pm-path", "--path"].flatMap((flag) => ["--fields", "--full", "--depth", "--"].map((path) => [flag, path])))("preserves %s with flag-looking tracker value %s", (flag, path) => {
    const argv = [flag, path, "get", "pm-one", "--fields", "title,typo", "--json"];
    expect(repairProjectionRecovery(argv, "unknown_field_projection", { suggested_retry_args: ["get", "pm-one", "--fields", "title"] })?.suggested_retry_args).toEqual([flag, path, "get", "pm-one", "--fields", "title", "--json"]);
  });

  it("retains supported root booleans and removes the underscore budget alias", () => {
    const argv = ["--explain", "--path", "/selected", "get", "pm-one", "--token_budget", "1000", "--full", "--json"];
    expect(repairProjectionRecovery(argv, "projection_options_mutually_exclusive", { suggested_retry_args: ["get", "pm-one", "--full"] })?.suggested_retry_args).toEqual(["--explain", "--path", "/selected", "get", "pm-one", "--full", "--json"]);
    expect(repairProjectionRecovery(["get", "pm-one", "--token_budget=1000", "--full", "--json"], "projection_options_mutually_exclusive", { suggested_retry_args: ["get", "pm-one", "--full"] })?.suggested_retry_args).toEqual(["get", "pm-one", "--full", "--json"]);
  });

  it("preserves attached extension controls whose value resembles a projection flag", () => {
    const argv = ["get", "pm-one", "--custom=--fields", "--fields", "title,typo", "--json"];
    expect(repairProjectionRecovery(argv, "unknown_field_projection", { suggested_retry_args: ["get", "pm-one", "--fields", "title"] })?.suggested_retry_args).toEqual(["get", "pm-one", "--custom=--fields", "--fields", "title", "--json"]);
  });

  it("withholds a retry when an unknown extension option has ambiguous value arity", () => {
    expect(repairProjectionRecovery(["get", "pm-one", "--custom", "--fields", "--fields", "title,typo"], "unknown_field_projection", { suggested_retry_args: ["get", "pm-one", "--fields", "title"] })?.suggested_retry_args).toBeUndefined();
  });

  it("removes conflicting intent/depth controls while retaining the producer budget and selected full mode", () => {
    const argv = ["get", "pm-selected", "--for=inspect", "--token-budget", "1000", "--full", "--fields", "id", "--depth", "deep", "--output-budget", "2000", "--json"];
    expect(repairProjectionRecovery(argv, "projection_options_mutually_exclusive", { suggested_retry_args: ["get", "pm-selected", "--full"] })?.suggested_retry_args).toEqual(["get", "pm-selected", "--full", "--output-budget", "2000", "--json"]);
  });

  it.each(["--full", "--brief", "--compact"])("retains the caller's single explicit %s mode over the generic suggestion", (mode) => {
    const argv = ["--path", "/selected", "list", mode, "--fields", "id", "--json"];
    expect(repairProjectionRecovery(argv, "projection_options_mutually_exclusive", { suggested_retry_args: ["list", mode === "--brief" ? "--full" : "--brief"] })?.suggested_retry_args).toEqual(["--path", "/selected", "list", mode, "--json"]);
  });

  it("uses the suggested mode when multiple explicit modes conflict", () => {
    expect(repairProjectionRecovery(["list", "--full", "--brief", "--json"], "projection_options_mutually_exclusive", { suggested_retry_args: ["list", "--brief"] })?.suggested_retry_args).toEqual(["list", "--brief", "--json"]);
  });

  it("leaves unrelated recovery and absent recovery unchanged", () => {
    const recovery = { suggested_retry_args: ["init"] };
    expect(repairProjectionRecovery([], "tracker_not_initialized", recovery)).toBe(recovery);
    expect(repairProjectionRecovery([], undefined, recovery)).toBe(recovery);
    expect(repairProjectionRecovery([], "unknown_field_projection", undefined)).toBeUndefined();
  });

  it.each([
    { code: "unknown_field_projection", argv: ["get", "pm-a", "--fields", "bad"], recovery: { suggested_retry: "pm get other" } },
    { code: "unknown_field_projection", argv: ["get", "pm-a", "--fields", "bad"], recovery: { suggested_retry_args: ["get", "other", "--full"] } },
    { code: "unknown_field_projection", argv: ["get", "pm-a", "--fields", "bad"], recovery: { suggested_retry_args: ["get", "other", "--fields"] } },
    { code: "unknown_field_projection", argv: ["get", "pm-a"], recovery: { suggested_retry_args: ["get", "other", "--fields", "id"] } },
    { code: "projection_options_mutually_exclusive", argv: ["get", "pm-a", "--full"], recovery: { suggested_retry_args: ["get", "other"] } },
    { code: "projection_options_mutually_exclusive", argv: ["get", "pm-a"], recovery: { suggested_retry_args: ["get", "other", "--full"] } },
  ])("withholds ambiguous runnable recovery instead of changing scope", ({ code, argv, recovery }) => {
    const result = repairProjectionRecovery(argv, code, recovery);
    expect(result?.suggested_retry_args).toBeUndefined();
    expect(result?.suggested_retry).toBeUndefined();
  });
});

describe("project-schema field route retry (pm-wftvem)", () => {
  const recovery = { provided_fields: ["gate_evidence"], suggested_flags: ["--gate-evidence"] };

  it.each([
    [["--pm-path", "/t", "update", "pm-1", "--field", 'gate_evidence={"a":1}', "--json"], ["--pm-path", "/t", "update", "pm-1", "--gate-evidence", '{"a":1}', "--json"]],
    [["update", "pm-1", "--field=gate_evidence=a=b", "--field", "team=x"], ["update", "pm-1", "--gate-evidence", "a=b", "--field", "team=x"]],
    [["update", "pm-1", "--field", " gate_evidence=ok "], ["update", "pm-1", "--gate-evidence", "ok"]],
  ])("rewrites only the refused assignment in %j", (argv, expected) => {
    const repaired = repairSchemaFieldRecovery(argv, "project_schema_field_requires_declared_flag", "gate_evidence", recovery);
    expect(repaired?.suggested_retry_args).toEqual(expected);
    expect(repaired?.suggested_retry).toContain("--gate-evidence");
    expect(repaired?.provided_fields).toEqual(["gate_evidence"]);
  });

  it("keeps the producer recovery when the retry would be a guess", () => {
    const twice = ["update", "pm-1", "--field", "gate_evidence=1", "--field", "gate_evidence=2"];
    expect(repairSchemaFieldRecovery(twice, "project_schema_field_requires_declared_flag", "gate_evidence", recovery)).toBe(recovery);
    const afterTerminator = ["update", "pm-1", "--", "--field", "gate_evidence=1"];
    expect(repairSchemaFieldRecovery(afterTerminator, "project_schema_field_requires_declared_flag", "gate_evidence", recovery)).toBe(recovery);
    const dangling = ["update", "pm-1", "--field"];
    expect(repairSchemaFieldRecovery(dangling, "project_schema_field_requires_declared_flag", "gate_evidence", recovery)).toBe(recovery);
    const bareKey = ["update", "pm-1", "--field", "gate_evidence"];
    expect(repairSchemaFieldRecovery(bareKey, "project_schema_field_requires_declared_flag", "gate_evidence", recovery)).toBe(recovery);
    const argv = ["update", "pm-1", "--field", "gate_evidence=1"];
    expect(repairSchemaFieldRecovery(argv, "extension_item_field_unknown", "gate_evidence", recovery)).toBe(recovery);
    expect(repairSchemaFieldRecovery(argv, "project_schema_field_requires_declared_flag", undefined, recovery)).toBe(recovery);
    expect(repairSchemaFieldRecovery(argv, "project_schema_field_requires_declared_flag", "gate_evidence", { provided_fields: ["gate_evidence"] })).toEqual({ provided_fields: ["gate_evidence"] });
    expect(repairSchemaFieldRecovery(argv, "project_schema_field_requires_declared_flag", "gate_evidence", undefined)).toBeUndefined();
  });
});
