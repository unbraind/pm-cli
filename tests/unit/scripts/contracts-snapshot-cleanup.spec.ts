import { beforeEach, describe, expect, it, vi } from "vitest";

const { rmSync } = vi.hoisted(() => ({ rmSync: vi.fn() }));

vi.mock("node:fs", () => ({ rmSync }));

import { removeTempDirectory } from "../../../scripts/contracts-snapshot-cleanup.mjs";

describe("scripts/contracts-snapshot-cleanup", () => {
  beforeEach(() => {
    rmSync.mockReset();
    vi.restoreAllMocks();
  });

  it("removes the temporary directory on the first attempt", async () => {
    removeTempDirectory("/tmp/pm-contracts");

    expect(rmSync).toHaveBeenCalledOnce();
    expect(rmSync).toHaveBeenCalledWith("/tmp/pm-contracts", {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  });

  it("retries transient filesystem cleanup failures with backoff", async () => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    rmSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("still busy"), { code: "ENOTEMPTY" });
    });

    removeTempDirectory("/tmp/pm-contracts");

    expect(rmSync).toHaveBeenCalledTimes(2);
    expect(waitSpy).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 50);
  });

  it("throws non-retryable cleanup failures immediately", async () => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    rmSync.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => removeTempDirectory("/tmp/pm-contracts")).toThrow(failure);
    expect(rmSync).toHaveBeenCalledOnce();
    expect(waitSpy).not.toHaveBeenCalled();
  });

  it("throws non-object cleanup failures immediately", async () => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    rmSync.mockImplementationOnce(() => {
      throw "cleanup failed";
    });

    expect(() => removeTempDirectory("/tmp/pm-contracts")).toThrow("cleanup failed");
    expect(rmSync).toHaveBeenCalledOnce();
    expect(waitSpy).not.toHaveBeenCalled();
  });

  it("throws after exhausting retryable cleanup failures", async () => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    const failure = Object.assign(new Error("still locked"), { code: "EBUSY" });
    rmSync.mockImplementation(() => {
      throw failure;
    });

    expect(() => removeTempDirectory("/tmp/pm-contracts")).toThrow(failure);
    expect(rmSync).toHaveBeenCalledTimes(8);
    expect(waitSpy).toHaveBeenCalledTimes(7);
    expect(waitSpy).toHaveBeenLastCalledWith(expect.any(Int32Array), 0, 0, 350);
  });
});
