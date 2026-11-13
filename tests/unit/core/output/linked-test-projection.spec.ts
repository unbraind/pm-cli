import { describe, expect, it } from "vitest";
import { formatOutput } from "../../../../src/core/output/output.js";
import {
  projectLinkedTestReply,
  QUIET_LINKED_TEST_STREAM_TAIL_CHARS,
  QUIET_LINKED_TEST_STREAM_TAIL_LINES,
  quietStreamTail,
} from "../../../../src/core/output/linked-test-projection.js";

const DEFAULTS = { lean: false, fullContext: false, fullOutput: false };
const CONTEXT_HINT = "not retained; a run with --check-context reports the full context";

/** One row's full sandbox context, the shape the SDK attaches to every run row. */
function fullContext(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requested_pm_context_mode: "schema",
    pm_context_mode: "schema",
    workspace_context_mode: "source",
    source_project_pm_path: "/home/agent/checkout/.agents/pm",
    sandbox_project_pm_path: `/tmp/pm-linked-test-${index}/project/.agents/pm`,
    source_global_pm_path: "/home/agent/.pm",
    sandbox_global_pm_path: `/tmp/pm-linked-test-${index}/global`,
    working_directory: "/home/agent/checkout",
    mismatch_detected: false,
    trust: { fingerprint: `fingerprint-${index}`, trusted: true, reason: "local_source_ref" },
    ...overrides,
  };
}

const VITEST_REPORT = [
  "\u001b[32m✓\u001b[39m tests/unit/a.spec.ts (12 tests) 40ms",
  "\u001b[32m✓\u001b[39m tests/unit/b.spec.ts (8 tests) 31ms",
  "\u001b[32m✓\u001b[39m tests/unit/c.spec.ts (3 tests) 12ms",
  "",
  "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m3 passed\u001b[39m\u001b[22m (3)",
  "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m23 passed\u001b[39m\u001b[22m (23)",
  "\u001b[2m   Start at \u001b[22m 19:32:45",
  "\u001b[2m   Duration \u001b[22m 412ms",
  "",
].join("\n");

function passingRow(index: number, stdout = VITEST_REPORT, contextOverrides: Record<string, unknown> = {}) {
  return {
    command: `node scripts/run-tests.mjs test -- tests/unit/${index}.spec.ts`,
    status: "passed",
    exit_code: 0,
    execution_context: fullContext(index, contextOverrides),
    stdout,
    stderr: "",
  };
}

describe("core/output/linked-test-projection", () => {
  it("keeps an escape-free bounded tail of a quiet row's stdout and names the restoring selector", () => {
    const reply = projectLinkedTestReply("test", { ok: true, run_results: [passingRow(1)] }, DEFAULTS) as {
      run_results: Array<Record<string, unknown>>;
      omission_receipt: Record<string, unknown>;
      execution_context: Record<string, unknown>;
    };
    const [row] = reply.run_results;
    expect(row?.stdout).toBe(
      [
        "✓ tests/unit/b.spec.ts (8 tests) 31ms",
        "✓ tests/unit/c.spec.ts (3 tests) 12ms",
        " Test Files  3 passed (3)",
        "      Tests  23 passed (23)",
        "   Start at  19:32:45",
        "   Duration  412ms",
        "",
      ].join("\n"),
    );
    expect(String(row?.stdout)).not.toContain("\u001b");
    expect(row?.stdout_omitted_bytes).toBe(
      Buffer.byteLength(VITEST_REPORT) - Buffer.byteLength(String(row?.stdout)),
    );
    expect(row).not.toHaveProperty("stderr_omitted_bytes");
    expect(reply.omission_receipt).toEqual({
      has_omissions: true,
      omitted_field_group_count: 1,
      omitted_field_groups: [{ name: "run_results.stdout", restore_with: "--full-output" }],
    });
    expect(reply.execution_context).toMatchObject({ trusted: true, restore_with: CONTEXT_HINT });
    // The JSON and TOON encodings carry the same escape-free tail.
    for (const json of [true, false]) {
      const rendered = formatOutput({ ok: true, run_results: [passingRow(1)] }, { json, command: "test" });
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\\u001b");
      expect(rendered).not.toContain("a.spec.ts");
      expect(rendered).toContain("--full-output");
    }
  });

  it("keeps complete streams on every row under --full-output and on any run that is not quiet", () => {
    const quiet = { ok: true, run_results: [passingRow(1), passingRow(2)] };
    const full = projectLinkedTestReply("test", quiet, { ...DEFAULTS, fullOutput: true }) as Record<string, unknown>;
    expect((full.run_results as Array<Record<string, unknown>>).map((row) => row.stdout)).toEqual([VITEST_REPORT, VITEST_REPORT]);
    expect(full).not.toHaveProperty("omission_receipt");
    // --full-output restores streams only; the context projection still applies.
    expect(full.execution_context).toMatchObject({ restore_with: CONTEXT_HINT });

    const failing = {
      ...passingRow(2),
      status: "failed",
      exit_code: 1,
      stdout: VITEST_REPORT,
      stderr: "\u001b[31mAssertionError\u001b[39m",
    };
    for (const variant of [
      { ok: false, run_results: [passingRow(1), failing] },
      { ok: true, run_results: [passingRow(1)], failure_categories: { empty_run: 1 } },
      { ok: true, run_results: [passingRow(1, VITEST_REPORT, { mismatch_detected: true })] },
      { ok: true, run_results: [passingRow(1), { ...passingRow(2), status: "skipped" }] },
    ]) {
      const kept = projectLinkedTestReply("test", variant, DEFAULTS) as Record<string, unknown>;
      const rows = kept.run_results as Array<Record<string, unknown>>;
      expect(rows.every((row) => !("stdout_omitted_bytes" in row))).toBe(true);
      expect(rows.map((row) => row.stdout)).toEqual(variant.run_results.map((row) => row.stdout));
      expect(rows.map((row) => row.stderr)).toEqual(variant.run_results.map((row) => row.stderr));
      expect(kept).not.toHaveProperty("omission_receipt");
    }
  });

  it("keeps the complete output of a row that passed only under an untrusted-command override", () => {
    const untrusted = passingRow(1, VITEST_REPORT, {
      trust: { fingerprint: "f", trusted: false, reason: "foreign_source_ref" },
    });
    const reply = projectLinkedTestReply("test", { ok: true, run_results: [untrusted, passingRow(2)] }, DEFAULTS) as {
      run_results: Array<Record<string, unknown>>;
      omission_receipt: { omitted_field_groups: unknown[] };
    };
    expect(reply.run_results[0]?.stdout).toBe(VITEST_REPORT);
    expect(reply.run_results[0]?.execution_context).toMatchObject({ trusted: false, trust_reason: "foreign_source_ref" });
    expect(reply.run_results[1]?.stdout).not.toBe(VITEST_REPORT);
    expect(reply.omission_receipt.omitted_field_groups).toHaveLength(1);
  });

  it("bounds stderr too and appends to an omission receipt the reply already carries", () => {
    const row = { ...passingRow(1, "ok\n"), stderr: "\u001b[33mwarn\u001b[39m: slow suite\n" };
    const reply = projectLinkedTestReply(
      "test",
      {
        ok: true,
        run_results: [row],
        omission_receipt: {
          has_omissions: true,
          omitted_field_group_count: 1,
          omitted_field_groups: [{ name: "tests", restore_with: "--full-history" }],
        },
      },
      DEFAULTS,
    ) as { run_results: Array<Record<string, unknown>>; omission_receipt: Record<string, unknown> };
    expect(reply.run_results[0]).toMatchObject({ stdout: "ok\n", stderr: "warn: slow suite\n", stderr_omitted_bytes: 10 });
    expect(reply.run_results[0]).not.toHaveProperty("stdout_omitted_bytes");
    expect(reply.omission_receipt).toEqual({
      has_omissions: true,
      omitted_field_group_count: 2,
      omitted_field_groups: [
        { name: "tests", restore_with: "--full-history" },
        { name: "run_results.stderr", restore_with: "--full-output" },
      ],
    });
  });

  it("reduces terminal output the way a terminal shows it", () => {
    expect(quietStreamTail("")).toBe("");
    expect(quietStreamTail("\n\n")).toBe("\n\n");
    expect(quietStreamTail("short\n")).toBe("short\n");
    expect(quietStreamTail("no newline")).toBe("no newline");
    // A carriage-return progress overwrite keeps its final segment; CRLF endings keep the line.
    expect(quietStreamTail("10%\r50%\r100% done\n")).toBe("100% done\n");
    expect(quietStreamTail("one\r\ntwo\r\n")).toBe("one\ntwo\n");
    // Only escape sequences: nothing a reader can use survives.
    expect(quietStreamTail("\u001b[0m\u001b[2K")).toBe("");
    const many = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(quietStreamTail(many).split("\n")).toHaveLength(QUIET_LINKED_TEST_STREAM_TAIL_LINES);
    expect(quietStreamTail(many).endsWith("line 20")).toBe(true);
    // The character ceiling cuts on code points, never inside a surrogate pair.
    const wide = "🧪".repeat(QUIET_LINKED_TEST_STREAM_TAIL_CHARS + 5);
    const tail = quietStreamTail(wide);
    expect(Array.from(tail)).toHaveLength(QUIET_LINKED_TEST_STREAM_TAIL_CHARS);
    expect(tail).toBe("🧪".repeat(QUIET_LINKED_TEST_STREAM_TAIL_CHARS));
  });

  it("judges every test-all item as pm test would and hoists one context the quiet items share", () => {
    const quietItem = (id: string, index: number) => ({
      ok: true,
      id,
      run_results: [passingRow(index), passingRow(index + 1)],
      failure_categories: { assertion_failure: 0 },
    });
    const failingItem = {
      ok: false,
      id: "pm-c",
      run_results: [
        passingRow(7),
        { ...passingRow(8), status: "failed", exit_code: 1 },
      ],
      failure_categories: { assertion_failure: 1 },
    };
    const batch = { ok: true, totals: { items: 2 }, results: [quietItem("pm-a", 1), quietItem("pm-b", 3)] };
    const reply = projectLinkedTestReply("test-all", batch, DEFAULTS) as {
      execution_context: Record<string, unknown>;
      results: Array<Record<string, unknown>>;
      omission_receipt: Record<string, unknown>;
    };
    expect(reply.execution_context).toEqual({
      pm_context_mode: "schema",
      workspace_context_mode: "source",
      mismatch_detected: false,
      trusted: true,
      trust_reason: "local_source_ref",
      restore_with: CONTEXT_HINT,
    });
    expect(reply.results.every((entry) => !("execution_context" in entry))).toBe(true);
    expect(JSON.stringify(reply)).not.toContain("/home/agent");
    expect(JSON.stringify(reply)).not.toContain("/tmp/pm-linked-test");
    expect(reply.omission_receipt).toEqual({
      has_omissions: true,
      omitted_field_group_count: 1,
      omitted_field_groups: [{ name: "results.run_results.stdout", restore_with: "--full-output" }],
    });

    // A failing item keeps every row's full context and stream; quiet items are still reduced.
    const mixed = projectLinkedTestReply(
      "test-all",
      { ...batch, ok: false, results: [quietItem("pm-a", 1), failingItem] },
      DEFAULTS,
    ) as { execution_context?: unknown; results: Array<Record<string, unknown>> };
    expect(mixed.execution_context).toBeUndefined();
    expect(mixed.results[0]?.execution_context).toMatchObject({ restore_with: CONTEXT_HINT });
    const failingRows = mixed.results[1]?.run_results as Array<Record<string, unknown>>;
    expect(failingRows.map((row) => row.execution_context)).toEqual([fullContext(7), fullContext(8)]);
    expect(failingRows.map((row) => row.stdout)).toEqual([VITEST_REPORT, VITEST_REPORT]);

    // --check-context restores every row's full context; --full-output every stream.
    const restored = projectLinkedTestReply("test-all", batch, { ...DEFAULTS, fullContext: true, fullOutput: true }) as {
      execution_context?: unknown;
      results: Array<{ run_results: Array<Record<string, unknown>> }>;
      omission_receipt?: unknown;
    };
    expect(restored.execution_context).toBeUndefined();
    expect(restored.omission_receipt).toBeUndefined();
    expect(restored.results[0]?.run_results.map((row) => row.execution_context)).toEqual([fullContext(1), fullContext(2)]);
    expect(restored.results[1]?.run_results.map((row) => row.stdout)).toEqual([VITEST_REPORT, VITEST_REPORT]);

    // An item with no linked runs neither blocks nor joins the shared context.
    const withEmpty = projectLinkedTestReply(
      "test-all",
      { ...batch, results: [quietItem("pm-a", 1), { ok: true, id: "pm-e", run_results: [] }] },
      DEFAULTS,
    ) as { execution_context?: unknown; results: Array<Record<string, unknown>> };
    expect(withEmpty.execution_context).toMatchObject({ restore_with: CONTEXT_HINT });
    expect(withEmpty.results[1]).toEqual({ ok: true, id: "pm-e", run_results: [] });

    // Through the host renderer, the test-all reply prints no host path in either encoding.
    for (const json of [true, false]) {
      const rendered = formatOutput(batch, { json, command: "test-all" });
      expect(rendered).not.toContain("/home/agent");
      expect(rendered).not.toContain("sandbox_project_pm_path");
    }
  });

  it("returns replies it cannot read and other commands unchanged", () => {
    const notRows = { ok: true, results: "none" };
    expect(projectLinkedTestReply("test-all", notRows, DEFAULTS)).toBe(notRows);
    const mixedResults = { ok: true, results: [null] };
    expect(projectLinkedTestReply("test-all", mixedResults, DEFAULTS)).toBe(mixedResults);
    expect(projectLinkedTestReply("test-all", null, DEFAULTS)).toBeNull();
    expect(projectLinkedTestReply("test", null, DEFAULTS)).toBeNull();
    const nullRow = { ok: true, run_results: [null] };
    expect(projectLinkedTestReply("test", nullRow, DEFAULTS)).toBe(nullRow);
    // A quiet row without a stderr capture, and a malformed prior receipt, still project.
    const { stderr: _stderr, ...stdoutOnly } = passingRow(1, "\u001b[0m\n");
    const sparse = projectLinkedTestReply(
      "test",
      { ok: true, run_results: [stdoutOnly], omission_receipt: "malformed" },
      DEFAULTS,
    ) as { run_results: Array<Record<string, unknown>>; omission_receipt: Record<string, unknown> };
    expect(sparse.run_results[0]).toMatchObject({ stdout: "", stdout_omitted_bytes: 5 });
    expect(sparse.run_results[0]?.stderr).toBeUndefined();
    expect(sparse.omission_receipt).toEqual({
      has_omissions: true,
      omitted_field_group_count: 1,
      omitted_field_groups: [{ name: "run_results.stdout", restore_with: "--full-output" }],
    });
    const reply = { ok: true, run_results: [passingRow(1)] };
    expect(projectLinkedTestReply("get", reply, DEFAULTS)).toBe(reply);
    expect(projectLinkedTestReply(undefined, reply, DEFAULTS)).toBe(reply);
  });
});
