import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAssuranceWorkspaceContext: vi.fn(),
  evaluateAssuranceGate: vi.fn(),
  getAssuranceDeclaration: vi.fn(),
  listAssuranceDeclarations: vi.fn(),
  listAssuranceVerdicts: vi.fn(),
  putAssuranceDeclaration: vi.fn(),
  recordAssuranceVerdict: vi.fn(),
  removeAssuranceDeclaration: vi.fn(),
}));

vi.mock("../../../src/sdk/governance/assurance.js", () => ({
  ASSURANCE_GATE_TRIGGERS: ["ci"],
  evaluateAssuranceGate: mocks.evaluateAssuranceGate,
  getAssuranceDeclaration: mocks.getAssuranceDeclaration,
  listAssuranceDeclarations: mocks.listAssuranceDeclarations,
  listAssuranceVerdicts: mocks.listAssuranceVerdicts,
  putAssuranceDeclaration: mocks.putAssuranceDeclaration,
  recordAssuranceVerdict: mocks.recordAssuranceVerdict,
  removeAssuranceDeclaration: mocks.removeAssuranceDeclaration,
}));

vi.mock("../../../src/sdk/governance/assurance-runtime.js", () => ({
  createAssuranceWorkspaceContext: mocks.createAssuranceWorkspaceContext,
}));

import { runAssuranceAction } from "../../../src/sdk/governance/assurance-action.js";

describe("assurance action gate concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the registry and workspace reads before awaiting either", async () => {
    const releaseDeclarations: Array<
      (value: { items: never[] }) => void
    > = [];
    mocks.listAssuranceDeclarations.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDeclarations.push(resolve);
        }),
    );
    mocks.createAssuranceWorkspaceContext.mockResolvedValue({
      tree_id: "tree-123",
      items: [],
      terminal_statuses: [],
    });
    mocks.evaluateAssuranceGate.mockResolvedValue({
      gate_id: "delivery",
      tree_id: "tree-123",
      trigger: "ci",
      dry_run: true,
      verdict: "pass",
      exit_code: 0,
      assertions: [],
    });

    const pending = runAssuranceAction({
      action: "run",
      id: "delivery",
      trigger: "ci",
      dry_run: true,
    });
    await vi.waitFor(() => {
      expect(mocks.listAssuranceDeclarations).toHaveBeenCalledTimes(3);
    });
    try {
      expect(mocks.createAssuranceWorkspaceContext).toHaveBeenCalledOnce();
    } finally {
      for (const release of releaseDeclarations) release({ items: [] });
    }

    await expect(pending).resolves.toMatchObject({ verdict: "pass" });
    expect(mocks.evaluateAssuranceGate).toHaveBeenCalledWith(
      "delivery",
      { version: 1, measurements: [], assertions: [], gates: [] },
      expect.objectContaining({ tree_id: "tree-123" }),
      { trigger: "ci", dry_run: true },
    );
  });
});
