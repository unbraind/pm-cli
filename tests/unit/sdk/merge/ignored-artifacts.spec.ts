/** Git ignore protocol failures cannot authorize automatic receipt staging. */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ git: vi.fn(), input: vi.fn(), noStdin: false, brokenPipe: false, kill: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => {
    const pending = mocks.git(...args);
    let onError: () => void;
    pending.child = { stdin: mocks.noStdin ? null : {
      on: (_event: string, listener: () => void) => { onError = listener; },
      end: (value: string) => { mocks.input(value); if (mocks.brokenPipe) onError(); },
    }, kill: mocks.kill };
    return pending;
  } }),
}));
import { inspectIgnoredMergeArtifacts } from "../../../../src/sdk/merge/ignored-artifacts.js";

describe("merge artifact ignore diagnostics", () => {
  afterEach(() => { mocks.git.mockReset(); mocks.input.mockReset(); mocks.kill.mockReset(); mocks.noStdin = false; mocks.brokenPipe = false; });
  it("does not invoke Git without candidate paths", async () => {
    expect(await inspectIgnoredMergeArtifacts("/workspace", [])).toEqual([]);
    expect(mocks.git).not.toHaveBeenCalled();
  });
  it("decodes spaces and newlines literally and excludes effective negations", async () => {
    mocks.git.mockResolvedValue({ stdout: ".gitignore\0" + "4\0private receipts/\0private receipts/a\nfile.json\0.git/info/exclude\0" + "9\0!retained.json\0retained.json\0" });
    expect(await inspectIgnoredMergeArtifacts("/workspace", ["private receipts/a\nfile.json", "retained.json"])).toEqual([
      { source: ".gitignore", line: 4, pattern: "private receipts/", path: "private receipts/a\nfile.json" },
    ]);
    expect(mocks.git).toHaveBeenCalledWith("git", ["check-ignore", "--verbose", "-z", "--stdin"], expect.any(Object));
    expect(mocks.input).toHaveBeenCalledWith("private receipts/a\nfile.json\0retained.json\0");
  });
  it("accepts Git's no-match exit and refuses unavailable evidence", async () => {
    mocks.git.mockRejectedValueOnce({ code: 1 });
    expect(await inspectIgnoredMergeArtifacts("/workspace", ["receipt.json"])).toEqual([]);
    mocks.git.mockRejectedValueOnce(new Error("Git failed"));
    await expect(inspectIgnoredMergeArtifacts("/workspace", ["receipt.json"])).rejects.toMatchObject({
      context: { code: "merge_settlement_review_required", reason: "ignore_check_unavailable" },
    });
  });
  it.each(["missing stdin", "broken pipe"])("retains subprocess failure on %s", async (mode) => {
    mocks.noStdin = mode === "missing stdin"; mocks.brokenPipe = mode === "broken pipe";
    mocks.git.mockRejectedValue(new Error("spawn failed"));
    await expect(inspectIgnoredMergeArtifacts("/workspace", ["receipt.json"])).rejects.toMatchObject({ context: { reason: "ignore_check_unavailable" } });
    expect(mocks.kill).toHaveBeenCalledTimes(mode === "broken pipe" ? 1 : 0);
  });
});
