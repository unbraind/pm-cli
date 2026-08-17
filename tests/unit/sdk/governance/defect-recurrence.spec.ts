import { describe, expect, it } from "vitest";

import {
  analyzeDefectChangeRisk,
  buildDefectRecurrenceIndex,
  evaluateDefectGateEvidence,
  parseDefectRecurrencePolicy,
  parseDefectChangeRiskRequest,
  type DefectRecurrenceFamily,
  type DefectRecurrencePolicy,
} from "../../../../src/sdk/governance/defect-recurrence.js";

const family = (
  overrides: Partial<DefectRecurrenceFamily> = {},
): DefectRecurrenceFamily => ({
  id: "path-slug-boundary",
  version: 1,
  title: "Path and slug boundary drift",
  owner_item_id: "pm-owner",
  escape_class: "production_defect",
  triggers: {
    file_patterns: ["src/sdk/agent/**", "tests/fixtures/boundaries/*"],
    package_names: ["@unbrained/pm-cli"],
    item_ids: ["pm-history"],
    tags: ["boundary-contract"],
    error_codes: ["invalid_workspace_path"],
  },
  checks: {
    local: ["pnpm test -- boundary"],
    hosted: ["CI / test-shard"],
  },
  negative_control: { files: ["src/sdk/agent/author.ts"] },
  historical_item_ids: ["pm-production-defect"],
  budget: { max_escape_rate: 0, max_false_positive_rate: 0.05 },
  ...overrides,
});

const policy = (families = [family()]): DefectRecurrencePolicy => ({
  version: 1,
  evidence_epoch: "2026-08-16T12:00:00.000Z",
  families,
});

describe("defect recurrence SDK", () => {
  it("builds a deterministic sparse index and explains every matching signal", () => {
    const inputPolicy = policy();
    const items = [
      {
        id: "pm-production-defect",
        status: "closed",
        type: "Issue",
        tags: ["boundary-contract"],
        files: [{ path: "src/sdk/agent/refusal-reachability.ts" }],
        package_names: ["@unbrained/pm-cli"],
        error_codes: ["invalid_workspace_path"],
      },
      { id: "pm-unrelated", status: "open", type: "Task" },
    ];
    const first = buildDefectRecurrenceIndex(inputPolicy, items);
    const second = buildDefectRecurrenceIndex(inputPolicy, items);

    expect(second).toEqual(first);
    expect(first.item_families).toEqual({
      "pm-production-defect": ["path-slug-boundary"],
    });
    expect(first.build).toEqual({
      items_scanned: 2,
      items_reused: 0,
      items_indexed: 1,
    });

    const report = analyzeDefectChangeRisk(first, {
      files: ["src/sdk/agent/author.ts"],
      package_names: ["@unbrained/pm-cli"],
      item_ids: ["pm-production-defect", "pm-history"],
      tags: ["boundary-contract"],
      error_codes: ["invalid_workspace_path"],
    });
    expect(report.risk_detected).toBe(true);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.reasons.map((reason) => reason.signal)).toEqual([
      "error_code",
      "file",
      "item",
      "item",
      "package",
      "tag",
    ]);
    expect(report.required_local_checks).toEqual(["pnpm test -- boundary"]);
    expect(report.required_hosted_checks).toEqual(["CI / test-shard"]);
    expect(report.cost).toMatchObject({
      families_evaluated: 1,
      signals_evaluated: 6,
      families_selected: 1,
    });
    expect(report.cost.estimated_output_tokens).toBeGreaterThan(0);
  });

  it("reuses unaffected item mappings during an incremental rebuild", () => {
    const inputPolicy = policy();
    const initial = buildDefectRecurrenceIndex(inputPolicy, [
      { id: "pm-production-defect", status: "closed", type: "Issue" },
      { id: "pm-history", status: "open", type: "Task" },
    ]);
    const incremental = buildDefectRecurrenceIndex(
      inputPolicy,
      [{ id: "pm-history", status: "closed", type: "Task", tags: [] }],
      { previous_index: initial, changed_item_ids: ["pm-history"] },
    );

    expect(incremental.item_families).toEqual({
      "pm-history": ["path-slug-boundary"],
      "pm-production-defect": ["path-slug-boundary"],
    });
    expect(incremental.build).toEqual({
      items_scanned: 1,
      items_reused: 1,
      items_indexed: 2,
    });

    const sparseFamily = family({
      id: "sparse",
      triggers: { item_ids: ["pm-sparse"] },
      negative_control: { item_ids: ["pm-sparse"] },
      historical_item_ids: ["pm-sparse"],
    });
    const sparse = buildDefectRecurrenceIndex(policy([sparseFamily]), [
      {
        id: "pm-sparse",
        status: "open",
        type: "Task",
        tags: [42, "boundary-contract"],
        files: [null, [], {}, { path: 42 }, { path: "src/ignored.ts" }],
        package_names: [42, "kept"],
        error_codes: [false, "kept"],
      } as never,
    ]);
    expect(sparse.item_families).toEqual({ "pm-sparse": ["sparse"] });
    expect(
      analyzeDefectChangeRisk(sparse, {
        files: ["unmatched.ts"],
        package_names: ["unmatched-package"],
      }).risk_detected,
    ).toBe(false);
    expect(analyzeDefectChangeRisk(sparse, {}).risk_detected).toBe(false);
    expect(
      buildDefectRecurrenceIndex(policy([sparseFamily]), [
        {
          id: "pm-non-array-files",
          status: "open",
          type: "Task",
          files: "src/not-an-array.ts",
        } as never,
      ]).item_families,
    ).toEqual({});

    const absentMappings = buildDefectRecurrenceIndex(policy(), [], {
      previous_index: {
        ...initial,
        item_families: undefined,
      } as never,
      changed_item_ids: ["pm-history"],
    });
    expect(absentMappings.build.items_reused).toBe(0);

    const unchanged = buildDefectRecurrenceIndex(inputPolicy, [], {
      previous_index: initial,
      changed_item_ids: [],
    });
    expect(unchanged.item_families).toEqual(initial.item_families);
    expect(unchanged.index_fingerprint).toBe(initial.index_fingerprint);
    expect(unchanged.build).toEqual({
      items_scanned: 0,
      items_reused: 2,
      items_indexed: 2,
    });

    const unicodeFamilies = [
      family({ id: "ä-family", title: "Umlaut" }),
      family({ id: "z-family", title: "Latin" }),
    ];
    const unicodeItems = [
      {
        id: "ä-item",
        status: "open",
        type: "Task",
        tags: ["boundary-contract"],
      },
      {
        id: "z-item",
        status: "open",
        type: "Task",
        tags: ["boundary-contract"],
      },
    ];
    expect(
      buildDefectRecurrenceIndex(policy(unicodeFamilies), unicodeItems)
        .index_fingerprint,
    ).toBe(
      buildDefectRecurrenceIndex(
        policy([...unicodeFamilies].reverse()),
        [...unicodeItems].reverse(),
      ).index_fingerprint,
    );
  });

  it("paginates against an immutable index identity and rejects stale cursors", () => {
    const families = [
      family({ id: "a", title: "A" }),
      family({ id: "b", title: "B" }),
      family({ id: "c", title: "C" }),
    ];
    const index = buildDefectRecurrenceIndex(policy(families), []);
    const first = analyzeDefectChangeRisk(
      index,
      { files: ["src/sdk/agent/author.ts"] },
      { limit: 2 },
    );
    expect(first.items.map((item) => item.family_id)).toEqual(["a", "b"]);
    expect(first.total).toBe(3);
    expect(first.next_cursor).toBeTypeOf("string");
    const second = analyzeDefectChangeRisk(
      index,
      { files: ["src/sdk/agent/author.ts"] },
      { cursor: first.next_cursor, limit: 2 },
    );
    expect(second.items.map((item) => item.family_id)).toEqual(["c"]);
    expect(second.next_cursor).toBeUndefined();

    expect(() =>
      analyzeDefectChangeRisk(index, {}, { cursor: "not-json" }),
    ).toThrow("cursor is invalid");
    const stale = Buffer.from(
      JSON.stringify({ index_fingerprint: "old", offset: 0 }),
    ).toString("base64url");
    expect(() => analyzeDefectChangeRisk(index, {}, { cursor: stale })).toThrow(
      "does not match this index",
    );
    for (const limit of [0, 101, 1.5]) {
      expect(() => analyzeDefectChangeRisk(index, {}, { limit })).toThrow(
        "limit must be an integer",
      );
    }
    for (const payload of [
      null,
      [],
      {},
      { index_fingerprint: index.index_fingerprint },
    ]) {
      const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
      expect(() => analyzeDefectChangeRisk(index, {}, { cursor })).toThrow(
        "does not match this index",
      );
    }

    const noMatch = analyzeDefectChangeRisk(index, { files: ["README.md"] });
    expect(noMatch).toMatchObject({ risk_detected: false, items: [] });

    const overlapping = buildDefectRecurrenceIndex(
      policy([
        family({
          triggers: { file_patterns: ["src/**", "src/sdk/**"] },
        }),
      ]),
      [],
    );
    expect(
      analyzeDefectChangeRisk(overlapping, { files: ["src/sdk/index.ts"] })
        .items[0]?.reasons,
    ).toHaveLength(2);

    const boundedPatternCache = buildDefectRecurrenceIndex(
      policy([
        family({
          triggers: {
            file_patterns: [
              "src/sdk/**",
              ...Array.from(
                { length: 1_024 },
                (_, index) => `generated/${index}.ts`,
              ),
            ],
          },
        }),
      ]),
      [],
    );
    expect(
      analyzeDefectChangeRisk(boundedPatternCache, {
        files: ["src/sdk/governance/assurance-action.ts"],
      }).risk_detected,
    ).toBe(true);
  });

  it("fails closed for missing evidence and accepts complete gate proof or a live waiver", () => {
    const report = evaluateDefectGateEvidence(
      [
        {
          id: "pm-missing",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T12:01:00.000Z",
        },
        {
          id: "pm-invalid",
          status: "closed",
          type: "Task",
          tags: ["security"],
          completed_at: "2026-08-16T12:02:00.000Z",
          escape_class: "unknown",
          gate_evidence: {},
        },
        {
          id: "pm-invalid-scalar-evidence",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T12:02:30.000Z",
          escape_class: "production_defect",
          gate_evidence: "not-structured",
        },
        {
          id: "pm-gated",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T12:03:00.000Z",
          escape_class: "scanner_finding",
          gate_evidence: {
            disposition: "gate_added",
            gate_id: "security",
            negative_control: "node gate.mjs --negative-control",
            local_checks: ["pnpm audit"],
            hosted_checks: ["Security / scan"],
            owner: "pm-owner",
          },
        },
        {
          id: "pm-waived",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T12:04:00.000Z",
          escape_class: "review_caught_late",
          gate_evidence: {
            disposition: "explicit_waiver",
            owner: "pm-owner",
            waiver_reason: "Provider is unavailable in the sandbox",
            waiver_expires_at: "2026-08-18T00:00:00.000Z",
          },
        },
        {
          id: "pm-expired",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T12:05:00.000Z",
          escape_class: "nightly_regression",
          gate_evidence: {
            disposition: "explicit_waiver",
            owner: "pm-owner",
            waiver_reason: "Temporary",
            waiver_expires_at: "2026-08-16T12:05:00.000Z",
          },
        },
        {
          id: "pm-before-epoch",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T11:59:00.000Z",
        },
        {
          id: "pm-no-completion",
          status: "open",
          type: "Task",
        },
        {
          id: "pm-terminal-non-defect",
          status: "closed",
          type: "Task",
          completed_at: "2026-08-16T12:06:30.000Z",
        },
        {
          id: "pm-missing-waiver-expiry",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T12:06:00.000Z",
          escape_class: "production_defect",
          gate_evidence: {
            disposition: "explicit_waiver",
            owner: "pm-owner",
            waiver_reason: "Expiry is deliberately absent",
          },
        },
        {
          id: "pm-invalid-completed-at",
          status: "closed",
          type: "Issue",
          created_at: "2026-08-16T12:02:00.000Z",
          completed_at: "not-a-date",
          escape_class: "production_defect",
          gate_evidence: {
            disposition: "gate_added",
            gate_id: "completion-timestamp",
            negative_control: "invalid completed_at is governed",
            local_checks: ["pnpm test -- defect-recurrence"],
            hosted_checks: ["CI / test-shard"],
            owner: "pm-owner",
          },
        },
        {
          id: "pm-unknown-disposition",
          status: "closed",
          type: "Issue",
          completed_at: "2026-08-16T11:58:00.000Z",
          escape_class: "production_defect",
          gate_evidence: { disposition: "unknown" },
        },
        {
          id: "pm-legacy-missing-completion",
          status: "closed",
          type: "Issue",
          created_at: "2026-08-16T11:30:00.000Z",
        },
      ],
      policy(),
      ["closed", "canceled"],
      new Date("2026-08-16T13:00:00.000Z"),
    );

    expect(report.ok).toBe(false);
    expect(report.governed_item_count).toBe(8);
    expect(report.classified_item_count).toBe(7);
    expect(report.class_counts).toEqual({
      nightly_regression: 1,
      production_defect: 4,
      review_caught_late: 1,
      scanner_finding: 1,
    });
    expect(report.evidence_disposition_counts).toEqual({
      explicit_waiver: 3,
      gate_added: 2,
      gate_strengthened: 0,
    });
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "expired_waiver",
      "invalid_escape_class",
      "invalid_gate_evidence",
      "invalid_completion_timestamp",
      "invalid_gate_evidence",
      "missing_escape_class",
      "missing_gate_evidence",
      "invalid_gate_evidence",
    ]);
  });

  it("uses closed_at for legacy records and governs fully undated terminal defects", () => {
    const completeEvidence = {
      escape_class: "production_defect" as const,
      gate_evidence: {
        disposition: "gate_added",
        gate_id: "completion-compatibility",
        negative_control: "missing completed_at remains governed",
        local_checks: ["pnpm test -- defect-recurrence"],
        hosted_checks: ["CI / test-shard"],
        owner: "pm-owner",
      },
    };
    const report = evaluateDefectGateEvidence(
      [
        {
          id: "pm-closed-after-epoch",
          status: "closed",
          type: "Issue",
          closed_at: "2026-08-16T12:01:00.000Z",
          ...completeEvidence,
        },
        {
          id: "pm-closed-before-epoch",
          status: "closed",
          type: "Issue",
          closed_at: "2026-08-16T11:59:00.000Z",
          ...completeEvidence,
        },
        { id: "pm-undated-legacy", status: "closed", type: "Issue" },
      ],
      policy(),
      ["closed"],
      new Date("2026-08-16T13:00:00.000Z"),
    );
    expect(report).toMatchObject({
      ok: false,
      governed_item_count: 2,
      classified_item_count: 2,
      findings: [
        { item_id: "pm-undated-legacy", kind: "invalid_completion_timestamp" },
        { item_id: "pm-undated-legacy", kind: "missing_escape_class" },
        { item_id: "pm-undated-legacy", kind: "missing_gate_evidence" },
      ],
    });
  });

  it("rejects malformed, duplicate, and unbounded policies", () => {
    expect(() => parseDefectChangeRiskRequest(null)).toThrow(
      "request must be an object",
    );
    expect(() => parseDefectChangeRiskRequest({ policy: policy() })).toThrow(
      "request.change must be an object",
    );
    expect(() => parseDefectRecurrencePolicy(null)).toThrow(
      "must be an object",
    );
    expect(() => parseDefectRecurrencePolicy({ version: 1 })).toThrow(
      "families must be an array",
    );
    const invalidPolicies: Array<[unknown, string]> = [
      [{ ...policy(), version: 2 }, "Unsupported"],
      [{ ...policy(), evidence_epoch: "never" }, "ISO timestamp"],
      [policy([family({ id: "" })]), "non-empty"],
      [policy([family(), family()]), "Duplicate"],
      [policy([family({ version: 0 })]), "positive integer"],
      [
        policy([family({ escape_class: "other" as "production_defect" })]),
        "escape class",
      ],
      [policy([family({ title: "" })]), "title"],
      [policy([family({ owner_item_id: "" })]), "owner_item_id"],
      [policy([family({ historical_item_ids: [] })]), "historical_item_ids"],
      [{ ...policy(), families: [null] }, "family must be an object"],
      [{ ...policy(), evidence_epoch: undefined }, "ISO timestamp"],
      [
        policy([family({ historical_item_ids: undefined as never })]),
        "historical_item_ids",
      ],
      [
        policy([family({ historical_item_ids: [42] as never })]),
        "historical_item_ids",
      ],
      [
        policy([family({ triggers: null as never })]),
        "triggers must be an object",
      ],
      [
        policy([family({ triggers: { package_names: [42] } as never })]),
        "triggers.package_names must be an array of strings",
      ],
      [
        policy([family({ triggers: { file_patterns: ["a".repeat(257)] } })]),
        "file pattern exceeds 256 characters",
      ],
      [
        policy([family({ triggers: { file_patterns: [42] as never } })]),
        "triggers.file_patterns must be an array of strings",
      ],
      [policy([family({ checks: null as never })]), "checks must contain"],
      [
        policy([family({ checks: { local: [42], hosted: [] } as never })]),
        "checks must contain",
      ],
      [
        policy([family({ checks: { local: [""], hosted: [] } })]),
        "checks must contain",
      ],
      [policy([family({ budget: null as never })]), "requires numeric budgets"],
      [
        policy([
          family({
            budget: { max_escape_rate: Number.NaN, max_false_positive_rate: 0 },
          }),
        ]),
        "requires numeric budgets",
      ],
      [
        policy([family({ negative_control: null as never })]),
        "negative_control must be an object",
      ],
      [
        policy([family({ negative_control: {} })]),
        "negative_control must select",
      ],
      [
        policy([
          family({
            budget: { max_escape_rate: -1, max_false_positive_rate: 2 },
          }),
        ]),
        "between 0 and 1",
      ],
    ];
    for (const [input, message] of invalidPolicies) {
      expect(() => parseDefectRecurrencePolicy(input)).toThrow(message);
    }
    expect(
      parseDefectChangeRiskRequest({
        policy: policy(),
        change: {},
        cursor: "cursor",
        limit: 5,
      }),
    ).toMatchObject({ cursor: "cursor", limit: 5 });
    expect(
      parseDefectChangeRiskRequest({ policy: policy(), change: {} }),
    ).toEqual({
      policy: policy(),
      change: {},
    });
    for (const [request, message] of [
      [{ policy: policy(), change: { files: [42] } }, "change.files"],
      [{ policy: policy(), change: {}, cursor: 42 }, "cursor must be a string"],
      [
        { policy: policy(), change: {}, limit: "5" },
        "limit must be an integer",
      ],
      [
        { policy: policy(), change: {}, limit: 1.5 },
        "limit must be an integer",
      ],
    ] as const) {
      expect(() => parseDefectChangeRiskRequest(request)).toThrow(message);
    }
  });
});
