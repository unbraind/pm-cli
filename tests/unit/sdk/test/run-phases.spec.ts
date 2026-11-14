import { describe, expect, it } from "vitest";
import { resolveLinkedTestRunSelection } from "../../../../src/core/test/run-selectors.js";
import {
  countFailureCategories,
  createEmptyFailureCategoryCounts,
  createLinkedTestSetupGate,
  isLinkedTestSetup,
  orderLinkedTestsSetupFirst,
  parseLinkedTestPhase,
  resolveSetupWorkspaceRefusal,
  withLinkedTestSetupEntries,
} from "../../../../src/sdk/test/run-phases.js";
import type { TestRunResult } from "../../../../src/sdk/test/execution.js";
import { assertTestMeasurementExecution } from "../../../../src/sdk/test/prerequisites.js";
import type { LinkedTest } from "../../../../src/types/index.js";

const build: LinkedTest = { command: "npm run build", scope: "project", phase: "setup" };
const unit: LinkedTest = { command: "node --test unit.js", scope: "project" };
const lint: LinkedTest = { command: "node --test lint.js", scope: "project" };
const seed: LinkedTest = { command: "node seed.js", scope: "project", phase: "setup" };

describe("sdk/test/run-phases", () => {
  it("parses the phase grammar and stores the default test phase as absent", () => {
    expect(parseLinkedTestPhase(undefined, "--add")).toBeUndefined();
    expect(parseLinkedTestPhase(" Setup ", "--add")).toBe("setup");
    expect(parseLinkedTestPhase("test", "--add")).toBeUndefined();
    expect(parseLinkedTestPhase("", "--add")).toBeUndefined();
    for (const invalid of ["teardown", true, 1]) {
      expect(() => parseLinkedTestPhase(invalid, "--add-json entry 1")).toThrow(
        expect.objectContaining({
          message: '--add-json entry 1 field "phase" must be one of: setup, test',
          exitCode: 2,
          code: "invalid_argument_value",
        }),
      );
    }
    expect(isLinkedTestSetup(build)).toBe(true);
    expect(isLinkedTestSetup(unit)).toBe(false);
  });

  it("puts every stored setup entry ahead of the regular tests, each group in stored order", () => {
    expect(orderLinkedTestsSetupFirst([unit, build, lint, seed])).toEqual([build, seed, unit, lint]);
    expect(orderLinkedTestsSetupFirst([unit, lint])).toEqual([unit, lint]);
  });

  it("prepends setup entries to a selection and reports what actually runs", () => {
    const stored = [unit, build, lint];
    // No selector: everything runs, setup first, and nothing extra is reported.
    expect(withLinkedTestSetupEntries(resolveLinkedTestRunSelection(stored, {}), stored)).toEqual({
      selector: null,
      requested: null,
      selected: [build, unit, lint],
      selected_indexes: [2, 1, 3],
      selected_count: 3,
      skipped_count: 0,
    });
    // A selector naming one regular test still runs the setup, and says so.
    expect(withLinkedTestSetupEntries(resolveLinkedTestRunSelection(stored, { onlyIndex: 3 }), stored)).toEqual({
      selector: "only-index",
      requested: "3",
      selected: [build, lint],
      selected_indexes: [2, 3],
      selected_count: 2,
      skipped_count: 1,
      setup_indexes: [2],
    });
    // A selector that already names the setup entry needs no setup_indexes.
    const both = withLinkedTestSetupEntries(resolveLinkedTestRunSelection([build, unit, lint], { match: "u" }), [build, unit, lint]);
    expect(both.selected).toEqual([build, unit]);
    expect(both.selected_indexes).toEqual([1, 2]);
    expect(both).not.toHaveProperty("setup_indexes");
    // A selector naming only setup entries runs just those.
    const setupOnly = resolveLinkedTestRunSelection(stored, { match: "build" });
    expect(withLinkedTestSetupEntries(setupOnly, stored)).toBe(setupOnly);
    // An item without setup entries, or without tests, keeps its selection object.
    const plain = resolveLinkedTestRunSelection([unit, lint], { onlyLast: true });
    expect(withLinkedTestSetupEntries(plain, [unit, lint])).toBe(plain);
    const empty = resolveLinkedTestRunSelection([], {});
    expect(withLinkedTestSetupEntries(empty, [])).toBe(empty);
  });

  it("marks setup rows, turns an executed setup failure into setup_failed, and blocks every later entry", () => {
    const gate = createLinkedTestSetupGate();
    const options = { failOnEmptyTestRun: true, requireAssertionsForPm: true, progress: true };
    expect(gate.options(build, options)).toEqual({ failOnEmptyTestRun: false, requireAssertionsForPm: false, progress: true });
    expect(gate.options(unit, options)).toBe(options);
    expect(gate.options(build, undefined)).toBeUndefined();
    expect(gate.blocked(build)).toBeUndefined();
    const passed: TestRunResult = { command: build.command, status: "passed", exit_code: 0, stdout: "built" };
    expect(gate.record(build, passed)).toEqual({ ...passed, phase: "setup" });
    expect(gate.blocked(unit)).toBeUndefined();
    const regular: TestRunResult = { command: unit.command, status: "failed", exit_code: 1, failure_category: "assertion_failure" };
    expect(gate.record(unit, regular)).toBe(regular);
    const failed: TestRunResult = { command: seed.command, status: "failed", exit_code: 3, failure_category: "timeout" };
    expect(gate.record(seed, failed)).toEqual({
      ...failed,
      phase: "setup",
      failure_category: "setup_failed",
      setup_failure_cause: "timeout",
    });
    expect(gate.blocked(lint)).toEqual({
      command: lint.command,
      path: undefined,
      status: "skipped",
      error: 'Skipped because setup entry "node seed.js" did not pass (setup_failed); no later linked command ran.',
    });
    expect(gate.blocked(build)).toMatchObject({ status: "skipped", phase: "setup" });
  });

  it("keeps a refused setup entry's own outcome, fails a setup that never executed, and blocks later entries", () => {
    const trust = createLinkedTestSetupGate();
    const refused: TestRunResult = { command: build.command, status: "failed", failure_category: "trust_refusal" };
    expect(trust.record(build, refused)).toEqual({ ...refused, phase: "setup" });
    expect(trust.blocked(unit)?.error).toContain("(trust_refusal)");

    const config = createLinkedTestSetupGate();
    const configRefusal: TestRunResult = { command: build.command, status: "refused", exit_code: null, failure_category: "config_refusal" };
    expect(config.record(build, configRefusal)).toEqual({ ...configRefusal, phase: "setup" });
    expect(config.blocked(unit)?.error).toContain("(config_refusal)");

    // A setup that never executed fails the run instead of skipping every dependent behind a pass.
    const skipped = createLinkedTestSetupGate();
    expect(skipped.record({ ...build, command: undefined, path: "docs/setup.md" }, { status: "skipped", error: "No command configured for this linked test." })).toEqual({
      status: "failed",
      phase: "setup",
      failure_category: "setup_failed",
      error: "No command configured for this linked test.",
    });
    expect(skipped.blocked(unit)?.error).toBe('Skipped because setup entry "docs/setup.md" did not pass (setup_failed); no later linked command ran.');

    // Recording an already-typed setup failure (as test-all's replay does) keeps it as it is.
    const replay = createLinkedTestSetupGate();
    const typed: TestRunResult = { command: build.command, status: "failed", phase: "setup", failure_category: "setup_failed", setup_failure_cause: "timeout" };
    expect(replay.record(build, typed)).toEqual(typed);
    expect(replay.blocked(unit)?.error).toContain("(setup_failed)");

    const bareRefusal = createLinkedTestSetupGate();
    expect(bareRefusal.record(build, { status: "refused" })).toEqual({ status: "refused", phase: "setup" });
    expect(bareRefusal.blocked(unit)?.error).toContain("(refused)");

    const unlabeled = createLinkedTestSetupGate();
    const uncategorized: TestRunResult = { status: "failed" };
    expect(unlabeled.record({ scope: "project", phase: "setup" }, uncategorized)).toEqual({ status: "failed", phase: "setup", failure_category: "setup_failed" });
    expect(unlabeled.blocked(unit)?.error).toContain('"<no command>"');
  });

  it("refuses only a setup entry whose workspace mode differs from a command it prepares", () => {
    expect(resolveSetupWorkspaceRefusal(unit, "source", new Set(["snapshot"]))).toBeUndefined();
    expect(resolveSetupWorkspaceRefusal(build, "isolated", new Set(["isolated"]))).toBeUndefined();
    expect(resolveSetupWorkspaceRefusal(build, "source", new Set())).toBeUndefined();
    expect(resolveSetupWorkspaceRefusal(build, "source", new Set(["source", "snapshot", "isolated"]))).toMatchObject({
      status: "refused",
      failure_category: "config_refusal",
      error: expect.stringContaining("run in isolated, snapshot,"),
    });
  });

  it("never admits a setup row as the executed linked test that --measure requires", () => {
    const setupRow: TestRunResult = { command: build.command, status: "passed", phase: "setup", stdout: "Tests 3 passed", stderr: "" };
    const testRow: TestRunResult = { command: unit.command, status: "passed", stdout: "Tests 3 passed", stderr: "" };
    const measure = { measure: ["duration=1"] };
    expect(() => assertTestMeasurementExecution("pm-a", measure, {}, "/tracker", [setupRow])).toThrow(
      expect.objectContaining({ code: "test_measure_requires_execution" }),
    );
    expect(() => assertTestMeasurementExecution("pm-a", measure, {}, "/tracker", [setupRow, testRow])).not.toThrow();
  });

  it("counts every failure category, including setup_failed, and only for failed or refused rows", () => {
    expect(createEmptyFailureCategoryCounts()).toMatchObject({ setup_failed: 0, assertion_failure: 0 });
    expect(
      countFailureCategories([
        { status: "failed", failure_category: "setup_failed" },
        { status: "refused", failure_category: "config_refusal" },
        { status: "skipped", failure_category: "timeout" },
        { status: "failed" },
        { status: "passed" },
      ]),
    ).toMatchObject({ setup_failed: 1, config_refusal: 1, timeout: 0 });
  });
});
