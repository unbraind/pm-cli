import { describe, expect, it } from "vitest";
import {
  PM_COMMAND_OUTPUT_BUDGET_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  PM_DIAGNOSTIC_DEGRADATION_STEPS,
  PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS,
  PM_DIAGNOSTIC_OUTPUT_CLASSES,
  PM_OUTPUT_DEGRADATION_STEPS,
  createPmCommandOutputBudget,
  definePmCommandOutputBudget,
  estimatePmOutputTokens,
  projectPmDiagnosticOutput,
  projectPmDiagnosticText,
  resolvePmDiagnosticOutputBudget,
  resolvePmCommandOutputBudget,
} from "../../../src/sdk/cli-contracts.js";

describe("agent output contracts", () => {
  it("declares exactly one deterministic budget for every built-in command", () => {
    expect(PM_COMMAND_OUTPUT_BUDGET_CONTRACTS).toHaveLength(
      PM_CORE_COMMAND_NAMES.length,
    );
    expect(
      new Set(
        PM_COMMAND_OUTPUT_BUDGET_CONTRACTS.map((contract) => contract.command),
      ).size,
    ).toBe(PM_CORE_COMMAND_NAMES.length);
    for (const contract of PM_COMMAND_OUTPUT_BUDGET_CONTRACTS) {
      expect(contract.default_max_estimated_tokens).toBeGreaterThan(0);
      expect(contract.default_max_estimated_tokens_by_format.toon).toBe(
        contract.default_max_estimated_tokens,
      );
      expect(
        contract.default_max_estimated_tokens_by_format.json,
      ).toBeGreaterThan(contract.default_max_estimated_tokens);
      expect(contract.degradation_ladder).toEqual(PM_OUTPUT_DEGRADATION_STEPS);
      expect(contract.allows_unbounded_opt_out).toBe(true);
      expect(contract.token_estimate).toBe("ceil(utf8_bytes / 4)");
    }
  });

  it("declares binding action-preserving budgets for every diagnostic family", () => {
    expect(PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS).toHaveLength(
      PM_DIAGNOSTIC_OUTPUT_CLASSES.length,
    );
    expect(
      PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS.map(
        ({ diagnostic_class: diagnosticClass }) => diagnosticClass,
      ),
    ).toEqual(PM_DIAGNOSTIC_OUTPUT_CLASSES);
    for (const contract of PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS) {
      expect(contract.degradation_ladder).toEqual(
        PM_DIAGNOSTIC_DEGRADATION_STEPS,
      );
      expect(contract.corrective_action_paths).toContain("required");
      expect(
        contract.default_max_estimated_tokens_by_format.text,
      ).toBeGreaterThanOrEqual(contract.minimum_max_estimated_tokens);
      expect(
        contract.default_max_estimated_tokens_by_format.json,
      ).toBeGreaterThan(contract.default_max_estimated_tokens_by_format.text);
    }
  });

  it("degrades oversized JSON diagnostics without dropping corrective action", () => {
    const projected = projectPmDiagnosticOutput(
      {
        type: "urn:pm-cli:error:invalid_argument_value",
        code: "invalid_argument_value",
        title: "Invalid value",
        detail: "x".repeat(4_000),
        required: "Use --status open and retry.",
        why: "y".repeat(4_000),
        examples: Array.from({ length: 40 }, (_, index) => `pm demo ${index}`),
        next_steps: [
          "Run pm demo --status open",
          ...Array(30).fill("inspect help"),
        ],
        recovery: {
          attempted_command: `pm demo ${"z".repeat(2_000)}`,
          normalized_args: Array(100).fill("argument"),
          suggested_retry: "pm demo --status open",
          allowed_values: Array(100).fill("open"),
        },
        exit_code: 2,
      },
      { maxEstimatedTokens: 192 },
    );

    expect(projected.required).toBe("Use --status open and retry.");
    expect(projected.recovery).toMatchObject({
      suggested_retry: "pm demo --status open",
    });
    expect(projected.diagnostic_output).toMatchObject({
      diagnostic_class: "error",
      format: "json",
      budget: 192,
      budget_source: "explicit",
      truncated: true,
    });
    expect(projected.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
    expect(Object.keys(projected).slice(0, 3)).toEqual([
      "code",
      "required",
      "recovery",
    ]);
  });

  it("never truncates executable retry argv during recovery compaction", () => {
    const suggestedRetryArgs = [
      "get",
      "pm-domain",
      "--fields",
      "id,title,status",
      "--output-budget",
      "unbounded",
    ];
    const projected = projectPmDiagnosticOutput(
      {
        code: "unknown_field_projection",
        required: "Use declared fields and retry.",
        detail: "detail ".repeat(4_000),
        recovery: {
          suggested_retry:
            "pm get pm-domain --fields id,title,status --output-budget unbounded",
          suggested_retry_args: suggestedRetryArgs,
          allowed_values: Array.from(
            { length: 200 },
            (_, index) => `field_${index}`,
          ),
        },
      },
      { diagnosticClass: "recovery_bundle" },
    );

    expect(projected.recovery).toMatchObject({
      suggested_retry_args: suggestedRetryArgs,
    });
  });

  it("keeps text diagnostics action-first at the smallest permitted budget", () => {
    const projected = projectPmDiagnosticText(
      `Error: Invalid value\n\nWhat happened:\n${"detail ".repeat(2_000)}`,
      "Use --status open and retry.",
      { maxEstimatedTokens: 192 },
    );

    expect(projected.output).toMatch(/^What is required:/u);
    expect(projected.output).toContain("Use --status open and retry.");
    expect(projected.diagnostic_output).toMatchObject({
      budget: 192,
      truncated: true,
      format: "text",
    });
    expect(projected.diagnostic_output.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
    expect(resolvePmDiagnosticOutputBudget("recovery_bundle")).toMatchObject({
      default_max_estimated_tokens_by_format: { text: 768, json: 2_000 },
    });
  });

  it("keeps short default-budget text unchanged and repairs an empty action", () => {
    const short = projectPmDiagnosticText("Short diagnostic", "Retry.");
    const repaired = projectPmDiagnosticText("detail ".repeat(2_000), "   ", {
      maxEstimatedTokens: 192,
    });

    expect(short).toMatchObject({
      output: "Short diagnostic",
      diagnostic_output: {
        budget: 768,
        budget_source: "default",
        truncated: false,
        degradation_steps: ["full"],
        omitted_fields: [],
      },
    });
    expect(repaired.output).toContain(
      "Inspect the diagnostic code and retry with corrected input.",
    );
    expect(repaired.diagnostic_output.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
  });

  it("keeps the minimum diagnostic ceiling binding when recovery itself is oversized", () => {
    const projected = projectPmDiagnosticOutput(
      {
        code: "oversized_recovery",
        required: "Inspect the legal domain and retry.",
        recovery: { suggested_retry: `pm demo ${"value ".repeat(5_000)}` },
        detail: "detail ".repeat(5_000),
      },
      { maxEstimatedTokens: 192 },
    );

    expect(projected.required).toBe("Inspect the legal domain and retry.");
    expect(projected.recovery).toBeUndefined();
    expect(projected.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
  });

  it("bounds receipt field names when a diagnostic has many top-level fields", () => {
    const noisyFields = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `unbounded_field_${index}_${"x".repeat(80)}`,
        "detail ".repeat(100),
      ]),
    );
    const projected = projectPmDiagnosticOutput(
      {
        code: "many_fields",
        required: "Retry with a valid value.",
        ...noisyFields,
      },
      { maxEstimatedTokens: 192 },
    );

    expect(projected.diagnostic_output).toMatchObject({
      budget: 192,
      truncated: true,
      omitted_fields_overflow_count: expect.any(Number),
    });
    expect(
      projected.diagnostic_output!.omitted_fields.length,
    ).toBeLessThanOrEqual(8);
    expect(
      projected.diagnostic_output!.omitted_fields_overflow_count,
    ).toBeGreaterThan(0);
    expect(projected.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
  });

  it("preserves safe own names and reports rejected prototype keys", () => {
    const underBudget = projectPmDiagnosticOutput(
      JSON.parse(
        '{"code":"own-fields","required":"Retry.","constructor":"owned","toString":"owned","valueOf":"owned"}',
      ),
    );
    expect(underBudget).toMatchObject({
      constructor: "owned",
      toString: "owned",
      valueOf: "owned",
    });

    const projected = projectPmDiagnosticOutput(
      JSON.parse(
        `{"code":"own-fields","required":"Retry.","constructor":"owned","toString":"owned","valueOf":"owned","__proto__":{"polluted":true},"detail":"${"x".repeat(4_000)}"}`,
      ),
      { maxEstimatedTokens: 192 },
    );

    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(Object.hasOwn(projected, "__proto__")).toBe(false);
    expect(projected.diagnostic_output!.omitted_fields).toContain("__proto__");
    expect(projected.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
  });

  it("covers default degradation when only a next step can supply the action", () => {
    const projected = projectPmDiagnosticOutput({
      code: 42,
      required: undefined,
      recovery: {},
      next_steps: ["Inspect the diagnostic code and retry."],
      detail: "detail ".repeat(5_000),
    });

    expect(projected.code).toBe("diagnostic");
    expect(projected.required).toBe(
      "Inspect the diagnostic code and retry with corrected input.",
    );
    expect(projected.next_steps).toEqual([
      "Inspect the diagnostic code and retry.",
    ]);
    expect(projected.diagnostic_output).toMatchObject({
      budget: 2_000,
      budget_source: "default",
      truncated: true,
    });
    expect(projected.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(
      2_000,
    );
  });

  it("truncates an oversized required action to the action-only ceiling", () => {
    const projected = projectPmDiagnosticOutput(
      {
        code: "oversized_required_action",
        required: "retry ".repeat(2_000),
        detail: "detail ".repeat(5_000),
      },
      { maxEstimatedTokens: 192 },
    );

    expect(projected.required).toMatch(/\.\.\.$/u);
    expect(String(projected.required).length).toBeLessThanOrEqual(160);
    expect(projected.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(
      192,
    );
  });

  it("binds multibyte JSON and text diagnostics by UTF-8 bytes", () => {
    const emoji = "🧭".repeat(4_000);
    const json = projectPmDiagnosticOutput(
      {
        code: emoji,
        required: emoji,
        recovery: { suggested_retry: "pm retry" },
        exit_code: 2,
        detail: emoji,
      },
      { maxEstimatedTokens: 192 },
    );
    const text = projectPmDiagnosticText(emoji, emoji, {
      maxEstimatedTokens: 192,
    });

    expect(json.diagnostic_output!.estimated_tokens).toBeLessThanOrEqual(192);
    expect(
      estimatePmOutputTokens(
        Buffer.byteLength(JSON.stringify(json, null, 2), "utf8"),
      ),
    ).toBeLessThanOrEqual(192);
    expect(text.diagnostic_output.estimated_tokens).toBeLessThanOrEqual(192);
    expect(
      estimatePmOutputTokens(Buffer.byteLength(text.output, "utf8")),
    ).toBeLessThanOrEqual(192);
  });

  it.each([0, 191, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid explicit diagnostic budget (%s)",
    (budget) => {
      expect(() =>
        projectPmDiagnosticOutput(
          { code: "demo", required: "Retry." },
          { maxEstimatedTokens: budget },
        ),
      ).toThrow("maxEstimatedTokens must be a safe integer >= 192");
      expect(() =>
        projectPmDiagnosticText("Diagnostic", "Retry.", {
          maxEstimatedTokens: budget,
        }),
      ).toThrow("maxEstimatedTokens must be a safe integer >= 192");
    },
  );

  it("resolves root commands, rejects unknown commands, and estimates UTF-8 tokens", () => {
    expect(resolvePmCommandOutputBudget("extension install")).toMatchObject({
      command: "extension install",
      budget_class: "discovery",
    });
    expect(resolvePmCommandOutputBudget("unknown")).toBeNull();
    expect(
      resolvePmCommandOutputBudget("package-custom report", {
        generateFallback: true,
      }),
    ).toMatchObject({
      command: "package-custom report",
      budget_class: "read",
      default_max_estimated_tokens_by_format: { toon: 4000, json: 6000 },
    });
    expect(estimatePmOutputTokens(0)).toBe(0);
    expect(estimatePmOutputTokens(5)).toBe(2);
    expect(estimatePmOutputTokens(-4)).toBe(0);
    expect(() => resolvePmDiagnosticOutputBudget("notice" as never)).toThrow(
      "diagnosticClass must be one of: error, warning, validation_summary, recovery_bundle",
    );
  });

  it("selects encoding-specific ceilings for exact command paths", () => {
    const budget = resolvePmCommandOutputBudget("comments-audit scan", {
      generateFallback: true,
    });
    expect(budget.command).toBe("comments-audit scan");
    expect(budget.default_max_estimated_tokens_by_format).toEqual({
      toon: 4_000,
      json: 6_000,
    });
  });

  it("preserves package-authored literal budget definitions", () => {
    const contract = definePmCommandOutputBudget({
      command: "get",
      budget_class: "read",
      default_max_estimated_tokens: 800,
      default_max_estimated_tokens_by_format: { toon: 800, json: 1200 },
      degradation_ladder: ["compact", "summary"],
      allows_unbounded_opt_out: false,
      token_estimate: "ceil(utf8_bytes / 4)",
    } as const);

    expect(contract.default_max_estimated_tokens).toBe(800);
    expect(contract.degradation_ladder).toEqual(["compact", "summary"]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid package-authored token ceiling (%s)",
    (defaultMaxEstimatedTokens) => {
      expect(() =>
        definePmCommandOutputBudget({
          command: "get",
          budget_class: "read",
          default_max_estimated_tokens: defaultMaxEstimatedTokens,
          default_max_estimated_tokens_by_format: { toon: 800, json: 1200 },
          degradation_ladder: ["summary"],
          allows_unbounded_opt_out: false,
          token_estimate: "ceil(utf8_bytes / 4)",
        }),
      ).toThrow(
        new RangeError(
          "default_max_estimated_tokens must be a positive safe integer",
        ),
      );
    },
  );

  it("rejects invalid format budgets and empty generated command paths", () => {
    expect(() =>
      definePmCommandOutputBudget({
        command: "get",
        budget_class: "read",
        default_max_estimated_tokens: 800,
        default_max_estimated_tokens_by_format: { toon: 0, json: 1200 },
        degradation_ladder: ["summary"],
        allows_unbounded_opt_out: false,
        token_estimate: "ceil(utf8_bytes / 4)",
      }),
    ).toThrow("default_max_estimated_tokens_by_format.toon");
    expect(() =>
      definePmCommandOutputBudget({
        command: "get",
        budget_class: "read",
        default_max_estimated_tokens: 800,
        default_max_estimated_tokens_by_format: { toon: 800, json: -1 },
        degradation_ladder: ["summary"],
        allows_unbounded_opt_out: false,
        token_estimate: "ceil(utf8_bytes / 4)",
      }),
    ).toThrow("default_max_estimated_tokens_by_format.json");
    expect(() => createPmCommandOutputBudget(" ")).toThrow(
      "command must be a non-empty command path",
    );
  });
});
