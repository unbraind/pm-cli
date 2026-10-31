import { describe, expect, it } from "vitest";
import {
  detectEmptyLinkedTestRun,
  findLinkedTestExecutionReceipt,
  renderLinkedTestRestoreCommand,
  resolveLinkedTestRestoreScope,
} from "../../../../src/sdk/test/execution-receipts.js";

describe("restore command scope", () => {
  it("adds --pm-path only for an explicit tracker root and shell-quotes every unsafe path", () => {
    const posix = { platform: "linux" as const };
    expect(renderLinkedTestRestoreCommand("pm-1", posix)).toBe("pm test pm-1 --list");
    expect(renderLinkedTestRestoreCommand("pm-1", { ...posix, trackerPath: "   " })).toBe("pm test pm-1 --list");
    expect(renderLinkedTestRestoreCommand("pm-1", { ...posix, trackerPath: "/srv/repo/.agents/pm" })).toBe(
      "pm test pm-1 --list --pm-path /srv/repo/.agents/pm",
    );
    expect(renderLinkedTestRestoreCommand("pm-1", { ...posix, trackerPath: "/srv/my repo/.agents/pm" })).toBe(
      'pm test pm-1 --list --pm-path "/srv/my repo/.agents/pm"',
    );
    // `$` and backticks are escaped, so copying the command never expands them.
    expect(renderLinkedTestRestoreCommand("pm-1", { ...posix, trackerPath: "/tmp/$HOME/`id`" })).toBe(
      'pm test pm-1 --list --pm-path "/tmp/\\$HOME/\\`id\\`"',
    );
    expect(renderLinkedTestRestoreCommand("pm-1", { platform: "win32", trackerPath: "C:\\my repo\\pm" })).toBe(
      'pm test pm-1 --list --pm-path "C:\\my repo\\pm"',
    );
  });

  it("keeps an explicit or PM_PATH-selected tracker and leaves a discovered one implicit", () => {
    const previous = process.env.PM_PATH;
    try {
      delete process.env.PM_PATH;
      expect(resolveLinkedTestRestoreScope({ path: "/srv/flag", noExtensions: true }, "/srv/root")).toEqual({
        trackerPath: "/srv/flag",
        noExtensions: true,
      });
      expect(resolveLinkedTestRestoreScope({}, "/srv/root").trackerPath).toBeUndefined();
      process.env.PM_PATH = "relative/pm";
      expect(resolveLinkedTestRestoreScope({}, "/srv/root").trackerPath).toBe("/srv/root");
      // A blank --path falls through to PM_PATH, exactly as resolvePmRoot does.
      expect(resolveLinkedTestRestoreScope({ path: "  " }, "/srv/root").trackerPath).toBe("/srv/root");
    } finally {
      if (previous === undefined) delete process.env.PM_PATH;
      else process.env.PM_PATH = previous;
    }
  });

  it("keeps --no-extensions when the narrowed invocation suppressed extensions", () => {
    expect(renderLinkedTestRestoreCommand("pm-1", { platform: "linux", noExtensions: true, trackerPath: "/srv/pm" })).toBe(
      "pm test pm-1 --list --no-extensions --pm-path /srv/pm",
    );
  });
});

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
