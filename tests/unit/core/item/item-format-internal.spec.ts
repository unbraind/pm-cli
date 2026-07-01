import { describe, expect, it } from "vitest";
import {
  _testOnlyItemFormat,
  canonicalDocument,
  normalizeFrontMatter,
  serializeItemDocument,
} from "../../../../src/core/item/item-format.js";

const FIXED_TS = "2026-02-22T00:00:00.000Z";

describe("item-format internal normalization helpers", () => {
  it("covers runtime required-for-type branches", () => {
    const base = {
      key: "release_train",
      metadata_key: "release_train",
      cli_flag: "release-train",
      cli_aliases: [],
      type: "string",
      commands: ["create", "update"],
      repeatable: false,
      required_on_create: false,
      allow_unset: true,
    };
    expect(_testOnlyItemFormat.runtimeFieldRequiredForType({ ...base, required: false, required_types: [] } as never, "Task")).toBe(
      false,
    );
    expect(_testOnlyItemFormat.runtimeFieldRequiredForType({ ...base, required: true, required_types: [] } as never, "Task")).toBe(
      true,
    );
    expect(
      _testOnlyItemFormat.runtimeFieldRequiredForType(
        { ...base, required: true, required_types: ["task", "issue"] } as never,
        "Task",
      ),
    ).toBe(true);
    expect(
      _testOnlyItemFormat.runtimeFieldRequiredForType(
        { ...base, required: true, required_types: ["issue"] } as never,
        "Task",
      ),
    ).toBe(false);
  });

  it("normalizes type options and body edge cases", () => {
    const knownFrontMatterKeys = _testOnlyItemFormat.buildKnownFrontMatterKeys({
      unknownFieldPolicy: "allow",
      extensionFieldNames: new Set(["custom_flag"]),
    } as never);
    expect(knownFrontMatterKeys.has("custom_flag")).toBe(true);
    expect(_testOnlyItemFormat.normalizeTypeOptions(undefined)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizeTypeOptions({ " b ": " two ", a: " one " } as never)).toEqual({
      a: "one",
      b: "two",
    });
    expect(_testOnlyItemFormat.normalizeTypeOptions({ " ": " " } as never)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizeBody("\n\nBody line  \n")).toBe("Body line");
    expect(_testOnlyItemFormat.firstNonZeroComparison([0, 0, 2, 1])).toBe(2);
    expect(_testOnlyItemFormat.firstNonZeroComparison([0, 0, 0])).toBe(0);
  });

  it("normalizes linked tests and test run summaries", () => {
    expect(_testOnlyItemFormat.normalizeTestRunSummaries(undefined)).toBeUndefined();
    const summaries = _testOnlyItemFormat.normalizeTestRunSummaries([
      {
        run_id: "run-1",
        kind: "test-all",
        status: "passed",
        started_at: FIXED_TS,
        finished_at: FIXED_TS,
        recorded_at: FIXED_TS,
        passed: 1,
        failed: 0,
        skipped: 0,
        items: 3,
        linked_tests: 2,
      },
      {
        run_id: "run-1",
        kind: "test",
        status: "passed",
        started_at: FIXED_TS,
        finished_at: FIXED_TS,
        recorded_at: FIXED_TS,
        passed: 1,
        failed: 0,
        skipped: 0,
      },
      {
        run_id: "",
        kind: "test",
        status: "failed",
        started_at: FIXED_TS,
        finished_at: FIXED_TS,
        recorded_at: FIXED_TS,
      },
    ] as never);
    expect(summaries?.map((entry) => entry.kind)).toEqual(["test", "test-all"]);
    expect(summaries?.[0]).toStrictEqual({
      run_id: "run-1",
      kind: "test",
      status: "passed",
      started_at: FIXED_TS,
      finished_at: FIXED_TS,
      recorded_at: FIXED_TS,
      passed: 1,
      failed: 0,
      skipped: 0,
    });

    const sortedTests = _testOnlyItemFormat.sortTests([
      {
        scope: "project",
        command: " npm test ",
        path: "/tmp/a.ts",
        timeout_seconds: 5,
        pm_context_mode: "tracker",
        shared_host_safe: true,
        env_set: { Z: " 2 ", A: " 1 " },
        env_clear: [" B ", "A", "A"],
        assert_stdout_contains: ["ok", " ok "],
        assert_stdout_regex: ["^ok$"],
        assert_stderr_contains: ["err"],
        assert_stderr_regex: ["^err$"],
        assert_stdout_min_lines: 2,
        assert_json_field_equals: { " status ": " pass " },
        assert_json_field_gte: { " count ": 2 },
        note: " first ",
      },
      {
        scope: "project",
        command: "npm test",
        path: "/tmp/a.ts",
        timeout_seconds: 5,
        pm_context_mode: "tracker",
        shared_host_safe: false,
        env_set: { A: "1" },
        env_clear: ["A"],
        assert_stdout_contains: ["ok"],
        assert_stdout_regex: ["^ok$"],
        assert_stderr_contains: ["err"],
        assert_stderr_regex: ["^err$"],
        assert_stdout_min_lines: 1,
        assert_json_field_equals: { status: "pass" },
        assert_json_field_gte: { count: 1 },
        note: "second",
      },
    ] as never);
    expect(sortedTests).toHaveLength(2);

    expect(
      _testOnlyItemFormat.sortTests([
        {
          scope: "project",
          command: "npm test",
          env_set: { " ": "kept out", EMPTY: " " },
          env_clear: [" "],
          assert_stdout_contains: [" "],
          assert_json_field_equals: { " ": "kept out", EMPTY: " " },
          assert_json_field_gte: { " ": 1, missing: Number.NaN },
        },
      ] as never),
    ).toStrictEqual([{ command: "npm test", scope: "project" }]);
    expect(_testOnlyItemFormat.sortTests("npm test" as never)).toBeUndefined();
    const nullPrototypeEnvSet = Object.assign(Object.create(null) as Record<string, string>, { SAFE: " value " });
    Object.defineProperty(nullPrototypeEnvSet, "__proto__", {
      enumerable: true,
      value: "blocked",
    });
    const numericAssertions = { count: 2, constructor: 3 };
    Object.defineProperty(numericAssertions, "__proto__", {
      enumerable: true,
      value: 4,
    });

    expect(
      _testOnlyItemFormat.sortTests([
        {
          scope: "project",
          command: "npm test",
          env_set: nullPrototypeEnvSet,
          env_clear: ["KEEP", 1],
          assert_stdout_contains: ["ok", 2],
          assert_json_field_equals: "not-a-record",
          assert_json_field_gte: numericAssertions,
        },
        {
          scope: "project",
          command: "pnpm test",
          env_set: ["not-a-record"],
          assert_json_field_gte: ["not-a-record"],
        },
      ] as never),
    ).toStrictEqual([
      {
        command: "npm test",
        scope: "project",
        env_set: { SAFE: "value" },
        env_clear: ["KEEP"],
        assert_stdout_contains: ["ok"],
        assert_json_field_gte: { count: 2 },
      },
      {
        command: "pnpm test",
        scope: "project",
      },
    ]);
  });

  it("normalizes nested plan metadata collections with invalid entries", () => {
    expect(_testOnlyItemFormat.normalizePlanStepLinks("not-array" as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanStepLinks([
        null,
        { id: "", kind: "dependency" },
        { id: "dep-1", kind: "dependency", note: " linked ", required_before_step: true },
      ] as never),
    ).toEqual([{ id: "dep-1", kind: "dependency", note: "linked", required_before_step: true }]);

    expect(_testOnlyItemFormat.normalizePlanStepFiles("nope" as never)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizePlanStepFiles([null, { path: "" }] as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanStepFiles([
        null,
        { path: "" },
        { path: " /tmp/file.ts ", scope: "project", note: " file note " },
      ] as never),
    ).toEqual([{ path: "/tmp/file.ts", scope: "project", note: "file note" }]);

    expect(_testOnlyItemFormat.normalizePlanStepTests("nope" as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanStepTests([
        null,
        {},
        { command: " pnpm test ", note: " test note " },
        { path: " /tmp/test.ts " },
      ] as never),
    ).toEqual([{ command: "pnpm test", note: "test note" }, { path: "/tmp/test.ts" }]);

    expect(_testOnlyItemFormat.normalizePlanStepDocs("nope" as never)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizePlanStepDocs([null, { path: "" }] as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanStepDocs([
        null,
        { path: "" },
        { path: " /tmp/doc.md ", scope: "global", note: " doc note " },
      ] as never),
    ).toEqual([{ path: "/tmp/doc.md", scope: "global", note: "doc note" }]);

    const steps = _testOnlyItemFormat.normalizePlanSteps([
      {
        id: "step-2",
        title: "Second",
        status: "pending",
        order: 2,
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      },
      {
        id: "step-1",
        title: "First",
        status: "pending",
        order: 1,
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      },
      {
        id: "missing-time",
        title: "Invalid",
        status: "pending",
        order: 3,
        created_at: "",
        updated_at: FIXED_TS,
      },
      {
        id: "bad-status",
        title: "Invalid",
        status: "bogus",
        order: 4,
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      },
      {
        id: "blank-order",
        title: "Invalid",
        status: "pending",
        order: " ",
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
      },
    ] as never);
    expect(steps?.map((step) => step.id)).toEqual(["step-1", "step-2"]);
    expect(
      _testOnlyItemFormat.normalizePlanSteps([
        {
          id: "bad-types",
          title: "Invalid",
          status: "pending",
          order: 1,
          created_at: 123,
          updated_at: {},
        },
      ] as never),
    ).toBeUndefined();

    expect(_testOnlyItemFormat.normalizePlanDecisions("bad" as never)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizePlanDecisions([{ ts: 1, author: {}, decision: "ignored" }] as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanDecisions([
        null,
        { ts: "", author: "agent", decision: "ignored" },
        { ts: FIXED_TS, author: "agent", decision: "ship", rationale: "why", evidence: "proof", step_id: "step-1" },
      ] as never),
    ).toEqual([{ ts: FIXED_TS, author: "agent", decision: "ship", rationale: "why", evidence: "proof", step_id: "step-1" }]);

    expect(_testOnlyItemFormat.normalizePlanDiscoveries("bad" as never)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizePlanDiscoveries([{ ts: 1, author: {}, text: "ignored" }] as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanDiscoveries([
        null,
        { ts: "", author: "agent", text: "ignored" },
        { ts: FIXED_TS, author: "agent", text: "found", step_id: "step-2" },
      ] as never),
    ).toEqual([{ ts: FIXED_TS, author: "agent", text: "found", step_id: "step-2" }]);

    expect(_testOnlyItemFormat.normalizePlanValidation("bad" as never)).toBeUndefined();
    expect(_testOnlyItemFormat.normalizePlanValidation([null, { text: " " }] as never)).toBeUndefined();
    expect(
      _testOnlyItemFormat.normalizePlanValidation([null, {}, { text: "run tests", command: "pnpm test", expected: "pass" }] as never),
    ).toEqual([{ text: "run tests", command: "pnpm test", expected: "pass" }]);
  });

  it("warns for normalized unknown schema fields in warn mode", () => {
    const warnings: string[] = [];
    const metadata = {
      id: "pm-1",
      title: "Title",
      status: "open",
      priority: 1,
      type: "Task",
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      tags: [],
      unknown_runtime_field: "kept",
    };
    expect(
      normalizeFrontMatter(metadata as never, {
        schema: { unknown_field_policy: "warn" } as never,
        onWarning: (warning) => warnings.push(warning),
      }),
    ).toMatchObject({ unknown_runtime_field: "kept" });
    expect(warnings).toEqual(["item_unknown_schema_fields:unknown_runtime_field"]);
  });

  it("warns for canonical unknown schema fields in warn mode", () => {
    const warnings: string[] = [];
    const metadata = {
      id: "pm-1",
      title: "Title",
      status: "open",
      priority: 1,
      type: "Task",
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      tags: [],
      unknown_runtime_field: "kept",
    };
    const canonical = canonicalDocument(
      { metadata: metadata as never, body: "Body" },
      {
        schema: { unknown_field_policy: "warn" } as never,
        onWarning: (warning) => warnings.push(warning),
      },
    );
    expect(canonical.metadata).toMatchObject({ unknown_runtime_field: "kept" });
    expect(warnings).toEqual(["item_unknown_schema_fields:unknown_runtime_field"]);
  });

  it("skips unsafe and malformed front matter extension fields", () => {
    const metadata = {
      id: "pm-1",
      title: "Title",
      status: "open",
      priority: 1,
      type: "Task",
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      tags: [],
      events: "not-an-array",
      custom_runtime_field: "kept",
      constructor: "blocked",
      prototype: "blocked",
    };
    Object.defineProperty(metadata, "__proto__", {
      enumerable: true,
      value: "blocked",
    });

    const normalized = normalizeFrontMatter(metadata as never, {
      schema: { unknown_field_policy: "allow" } as never,
    });

    expect(normalized).toMatchObject({ custom_runtime_field: "kept" });
    expect(normalized.events).toBeUndefined();
    expect(Object.hasOwn(normalized, "__proto__")).toBe(false);
    expect(Object.hasOwn(normalized, "constructor")).toBe(false);
    expect(Object.hasOwn(normalized, "prototype")).toBe(false);
  });

  it("serializes json-markdown with undefined body fallback", () => {
    const output = serializeItemDocument(
      {
        metadata: {
          id: "pm-1",
          title: "Title",
          status: "open",
          priority: "P2",
          type: "Task",
          created_at: FIXED_TS,
          updated_at: FIXED_TS,
          tags: [],
          dependencies: [],
          links: [],
          test_links: [],
          comments: [],
          notes: [],
          history_events: [],
        },
        body: undefined,
      } as never,
      { format: "json_markdown" },
    );
    expect(output).toContain("\"id\": \"pm-1\"");
    expect(output.endsWith("\n")).toBe(true);
  });
});
