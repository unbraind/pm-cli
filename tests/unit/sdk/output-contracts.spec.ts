import { describe, expect, it } from "vitest";
import {
  PM_COMMAND_OUTPUT_ENVELOPE_CONTRACTS,
  PM_CORE_COMMAND_NAMES,
  definePmCommandOutputEnvelope,
  isPmMutationReceipt,
  parsePmAgentTaskTranscriptCorpus,
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
    expect(resolvePmCommandOutputEnvelope("start-task")).toMatchObject({
      kind: "mutation_receipt",
      cardinality: "one",
    });
    expect(resolvePmCommandOutputEnvelope("close-many")).toMatchObject({
      kind: "collection",
      wrapper_key: "rows",
      cardinality: "many",
    });
    expect(resolvePmCommandOutputEnvelope("extension install")).toMatchObject({
      command: "extension install",
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

  it("parses versioned multi-step tasks with explicit refusal recovery", () => {
    const corpus = parsePmAgentTaskTranscriptCorpus({
      version: 1,
      tasks: [
        {
          id: " recover-context ",
          description: " Refuse an invalid intent and execute its recovery. ",
          steps: [
            {
              id: "refuse",
              args: ["list", "--for", "invalid"],
              expected_exit_code: 2,
              expected_output_kind: "refusal",
              required_fields: ["code", "recovery"],
              expected_error_code: "unknown_context_intent",
              expected_refusal_surface: "--for",
            },
            {
              id: "retry",
              args: ["list", "--for", "triage"],
              expected_exit_code: 0,
              expected_output_kind: "collection",
              required_fields: ["items"],
              recovery_for: "refuse",
            },
          ],
        },
      ],
    });

    expect(corpus).toMatchObject({
      version: 1,
      tasks: [
        {
          id: "recover-context",
          description: "Refuse an invalid intent and execute its recovery.",
          steps: [
            { id: "refuse", expected_output_kind: "refusal" },
            { id: "retry", recovery_for: "refuse" },
          ],
        },
      ],
    });
  });

  it.each([
    [null, "corpus must be an object"],
    [{ version: 2, tasks: [{}] }, "corpus version must be 1"],
    [{ version: 1, tasks: [] }, "corpus tasks must be non-empty"],
    [{ version: 1, tasks: [null] }, "tasks[0] must be an object"],
    [
      { version: 1, tasks: [{ id: " ", description: "x", steps: [{}] }] },
      "tasks[0].id must be a non-empty string",
    ],
    [
      { version: 1, tasks: [{ id: "task", description: " ", steps: [{}] }] },
      "tasks.task.description must be a non-empty string",
    ],
    [
      { version: 1, tasks: [{ id: "task", description: "x", steps: [] }] },
      "tasks.task.steps must be a non-empty array",
    ],
    [
      {
        version: 1,
        tasks: [{ id: "task", description: "x", steps: [null] }],
      },
      "steps[0] must be an object",
    ],
  ])("rejects malformed transcript containers %#", (value, message) => {
    expect(() => parsePmAgentTaskTranscriptCorpus(value)).toThrow(message);
  });

  it("fails closed on malformed or contradictory step contracts", () => {
    const validStep = {
      id: "step",
      args: ["list"],
      expected_exit_code: 0,
      expected_output_kind: "collection",
      required_fields: ["items"],
    };
    const parseStep = (step: unknown): void => {
      parsePmAgentTaskTranscriptCorpus({
        version: 1,
        tasks: [{ id: "task", description: "x", steps: [step] }],
      });
    };
    for (const [step, message] of [
      [{ ...validStep, id: " " }, ".id must be a non-empty string"],
      [{ ...validStep, args: [] }, ".args must be a non-empty string array"],
      [{ ...validStep, args: [7] }, ".args[0] must be a non-empty string"],
      [
        { ...validStep, expected_exit_code: 1.5 },
        ".expected_exit_code must be a safe integer",
      ],
      [
        { ...validStep, expected_output_kind: "unknown" },
        ".expected_output_kind is unsupported",
      ],
      [
        { ...validStep, required_fields: [] },
        ".required_fields must be a non-empty string array",
      ],
      [
        { ...validStep, required_fields: ["items..id"] },
        ".required_fields must contain dot-separated own-property paths",
      ],
      [
        { ...validStep, expected_error_code: " " },
        ".expected_error_code must be a non-empty string",
      ],
      [
        { ...validStep, expected_refusal_surface: " " },
        ".expected_refusal_surface must be a non-empty string",
      ],
      [
        { ...validStep, recovery_for: " " },
        ".recovery_for must be a non-empty string",
      ],
      [
        { ...validStep, expected_exit_code: 2 },
        "successful output must use exit code 0 or a command-declared successful effect exit",
      ],
      [
        { ...validStep, expected_exit_code: 6 },
        "successful output must use exit code 0 or a command-declared successful effect exit",
      ],
      [
        { ...validStep, expected_output_kind: "entity" },
        "list declares collection",
      ],
    ] as const) {
      expect(() => parseStep(step), message).toThrow(message);
    }

    for (const refusal of [
      {
        ...validStep,
        expected_output_kind: "refusal",
        expected_error_code: "bad",
        expected_refusal_surface: "--for",
      },
      {
        ...validStep,
        expected_exit_code: 2,
        expected_output_kind: "refusal",
        expected_refusal_surface: "--for",
      },
      {
        ...validStep,
        expected_exit_code: 2,
        expected_output_kind: "refusal",
        expected_error_code: "bad",
      },
      {
        ...validStep,
        expected_exit_code: 6,
        expected_output_kind: "refusal",
        expected_error_code: "bad",
        expected_refusal_surface: "--for",
      },
    ]) {
      expect(() => parseStep(refusal)).toThrow(
        "refusal steps require a non-success exit, error code, and refusal surface",
      );
    }
  });

  it("accepts command-declared no-effect and partial-effect success exits", () => {
    const corpus = parsePmAgentTaskTranscriptCorpus({
      version: 1,
      tasks: [
        {
          id: "bulk-effects",
          description:
            "Represent successful bulk commands without collapsing effect semantics.",
          steps: [
            {
              id: "no-effect",
              args: ["close-many", "pm-missing"],
              expected_exit_code: 6,
              expected_output_kind: "collection",
              required_fields: ["rows"],
            },
            {
              id: "partial-effect",
              args: ["update-many", "pm-one,pm-missing"],
              expected_exit_code: 7,
              expected_output_kind: "collection",
              required_fields: ["rows"],
            },
          ],
        },
      ],
    });

    expect(
      corpus.tasks[0]?.steps.map((step) => step.expected_exit_code),
    ).toEqual([6, 7]);
  });

  it("rejects duplicate identities and recovery that does not follow a refusal", () => {
    const success = {
      id: "same",
      args: ["list"],
      expected_exit_code: 0,
      expected_output_kind: "collection",
      required_fields: ["items"],
    };
    expect(() =>
      parsePmAgentTaskTranscriptCorpus({
        version: 1,
        tasks: [{ id: "task", description: "x", steps: [success, success] }],
      }),
    ).toThrow("duplicate step id same");
    expect(() =>
      parsePmAgentTaskTranscriptCorpus({
        version: 1,
        tasks: [
          {
            id: "task",
            description: "x",
            steps: [{ ...success, recovery_for: "missing" }],
          },
        ],
      }),
    ).toThrow("recovery_for must reference an earlier refusal");
    expect(() =>
      parsePmAgentTaskTranscriptCorpus({
        version: 1,
        tasks: [
          { id: "task", description: "x", steps: [success] },
          { id: "task", description: "y", steps: [success] },
        ],
      }),
    ).toThrow("duplicate agent-task transcript id task");
  });
});
