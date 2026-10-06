import { describe, expect, it } from "vitest";
import {
  detectEmptyLinkedTestRun,
  findLinkedTestExecutionReceipt,
} from "../../../../src/sdk/test/execution-receipts.js";

describe("linked-test runner receipts", () => {
  it.each([
    ["# tests 3", "reported_tests"],
    ["ℹ pass 2", "reported_passes"],
    ["Tests 4 passed", "tests_passed"],
    ["4 passed in 0.2s", "passed_count"],
    ["Tests: 2 passed, 5 total", "passed_count"],
    [" 2 pass\n 0 fail", "bun_pass_count"],
    ["Ran 3 tests across 1 file. [12ms]", "bun_executed_tests"],
  ])("recognizes the executed count in %s", (output, code) => {
    expect(findLinkedTestExecutionReceipt(output, "")).toEqual({
      code,
      stream: "stdout",
    });
  });

  it("retains Bun's stderr receipt and uses stdout first when both streams report execution", () => {
    expect(findLinkedTestExecutionReceipt("", "2 pass")).toEqual({
      code: "bun_pass_count",
      stream: "stderr",
    });
    expect(findLinkedTestExecutionReceipt("# tests 2", "4 pass")).toEqual({
      code: "reported_tests",
      stream: "stdout",
    });
  });

  it.each([
    ["No projects matched the filters", "no_projects_matched_filters"],
    ["No test files found", "no_test_files_found"],
    ["No tests found", "no_tests_found"],
    ["No matching test", "no_matching_tests"],
    ["collected 0 items", "collected_zero_items"],
    ["Ran 0 tests across 1 file.", "reported_zero_tests"],
    ["# tests 0\n# pass 0", "reported_zero_passes"],
    ["ℹ pass 0\nℹ tests 0", "reported_zero_passes"],
    ["# tests 0", "reported_zero_tests"],
  ])("keeps an explicit empty summary authoritative: %s", (output, code) => {
    expect(detectEmptyLinkedTestRun("Tests 2 passed", output)).toEqual({
      code,
    });
  });

  it.each([
    "",
    "0 pass\n0 fail",
    "tests completed",
    "Ran 0 tests across 0 files.",
  ])(
    "requires positive execution evidence rather than inferring it from %s",
    (output) => {
      expect(findLinkedTestExecutionReceipt(output, "")).toBeUndefined();
    },
  );

  it("does not classify successful nonzero summaries as empty", () => {
    expect(
      detectEmptyLinkedTestRun(
        "# tests 3\n# pass 3",
        "Ran 3 tests across 1 file.",
      ),
    ).toBeNull();
  });
});
