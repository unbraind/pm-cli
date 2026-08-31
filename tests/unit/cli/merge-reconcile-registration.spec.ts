import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runMergeDriver: vi.fn(),
  runMergeInstall: vi.fn(),
  runMergeReceiptEvidenceReport: vi.fn(),
  runMergeReconcile: vi.fn(),
}));

vi.mock("../../../src/cli/commands/merge.js", () => ({
  MERGE_DRIVER_ARTIFACT_VALUES: ["history"],
  runMergeDriver: mocks.runMergeDriver,
  runMergeInstall: mocks.runMergeInstall,
  runMergeReceiptEvidenceReport: mocks.runMergeReceiptEvidenceReport,
  runMergeReconcile: mocks.runMergeReconcile,
}));

import { registerMutationCommands } from "../../../src/cli/register-mutation.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json").option("--author <value>");
  registerMutationCommands(program);
  return program;
}

describe("merge reconcile registration", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    mocks.runMergeReceiptEvidenceReport.mockReset();
    mocks.runMergeReconcile.mockReset();
  });

  it("forwards reconcile options and maps a failed result onto process exit state", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.runMergeReconcile.mockResolvedValueOnce({ ok: true });
    await createProgram().parseAsync([
      "node",
      "pm",
      "--author",
      "merge-agent",
      "merge",
      "reconcile",
      "--dry-run",
      "--message",
      "verify merge",
      "--force",
    ]);
    expect(mocks.runMergeReconcile).toHaveBeenCalledWith(
      {
        dryRun: true,
        force: true,
        message: "verify merge",
        author: "merge-agent",
      },
      expect.objectContaining({ author: "merge-agent" }),
    );

    mocks.runMergeReconcile.mockResolvedValueOnce({ ok: false });
    await createProgram().parseAsync(["node", "pm", "merge", "reconcile"]);
    expect(process.exitCode).toBe(1);
  });

  it("rejects positional artifacts on the source registration path", async () => {
    await expect(
      createProgram().parseAsync([
        "node",
        "pm",
        "merge",
        "reconcile",
        "unexpected",
      ]),
    ).rejects.toThrow("merge reconcile takes no positional arguments");
  });

  it("reports clone-local decisions and rejects positional report arguments", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.runMergeReceiptEvidenceReport.mockResolvedValueOnce({
      ok: true,
      complete: true,
      count: 1,
      invalid_evidence_count: 0,
      receipts: [],
      generated_at: "2026-08-31T00:00:00.000Z",
    });

    await createProgram().parseAsync([
      "node",
      "pm",
      "merge",
      "report",
      "--include-reconciled",
    ]);

    expect(mocks.runMergeReceiptEvidenceReport).toHaveBeenCalledWith({
      includeReconciled: true,
    });
    await expect(
      createProgram().parseAsync([
        "node",
        "pm",
        "merge",
        "report",
        "unexpected",
      ]),
    ).rejects.toThrow("merge report takes no positional arguments");
  });

  it("fails the report command when receipt evidence is incomplete", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.runMergeReceiptEvidenceReport.mockResolvedValueOnce({
      ok: false,
      complete: false,
      count: 0,
      invalid_evidence_count: 2,
      receipts: [],
      generated_at: "2026-08-31T00:00:00.000Z",
    });

    await createProgram().parseAsync(["node", "pm", "merge", "report"]);

    expect(process.exitCode).toBe(1);
  });
});
