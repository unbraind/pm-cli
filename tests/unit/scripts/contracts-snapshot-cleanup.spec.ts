import { describe, expect, it, vi } from "vitest";

const { cleanupTempRoot } = vi.hoisted(() => ({
  cleanupTempRoot: vi.fn(),
}));

vi.mock("../../../scripts/smoke-cleanup.mjs", () => ({ cleanupTempRoot }));

import { removeTempDirectory } from "../../../scripts/contracts-snapshot-cleanup.mjs";

describe("scripts/contracts-snapshot-cleanup", () => {
  it("delegates temporary directory removal to the shared resilient cleanup primitive", () => {
    removeTempDirectory("/tmp/pm-contracts");

    expect(cleanupTempRoot).toHaveBeenCalledOnce();
    expect(cleanupTempRoot).toHaveBeenCalledWith("/tmp/pm-contracts");
  });
});
