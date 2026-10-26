/** Keep Git copy failures distinct from absent receipt authority at the native boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ names: vi.fn(), blobs: vi.fn(), git: vi.fn(), mode: "normal", input: [] as string[], killed: vi.fn() }));
vi.mock("node:fs/promises", async (load) => ({ ...(await load()), readdir: io.names, realpath: async (value: string) => value }));
vi.mock("../../../../src/sdk/merge/indexed-receipt-blobs.js", () => ({ readIndexedReceiptBlobs: io.blobs }));
vi.mock("node:child_process", async (load) => ({ ...(await load()), execFile: Object.assign(vi.fn(), {
  [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => {
    const hashing = (args[1] as string[])[0] === "hash-object";
    const pending = hashing && ["missing input", "broken input"].includes(io.mode) ? Promise.reject(new Error("Git input failed")) : io.git(...args);
    let onError: () => void;
    pending.child = { stdin: io.mode === "missing input" ? null : { on: (_event: string, listener: () => void) => { onError = listener; }, end: (raw: string) => { io.input.push(raw); if (io.mode === "broken input") onError(); } }, kill: io.killed };
    return pending;
  },
}) }));
import { seedSnapshotReceiptIndex } from "../../../../src/sdk/test/receipt-index-snapshot.js";

beforeEach(() => {
  io.mode = "normal"; io.input = []; io.killed.mockReset();
  io.names.mockReset().mockResolvedValue(["one.json", "notes.txt"]);
  io.blobs.mockReset().mockResolvedValue(new Map([["one.json", '{"source":"é"}\n']]));
  io.git.mockReset().mockImplementation(async (_command, args) => ({ stdout: args[0] === "hash-object" ? "a".repeat(40) : "" }));
});

describe("snapshot receipt copy boundaries", () => {
  it("writes only source-index bytes into the snapshot object store and namespace", async () => {
    await seedSnapshotReceiptIndex("/source", "/snapshot", "/source/state");
    expect(io.input).toEqual(['{"source":"é"}\n']);
    expect(io.blobs.mock.calls[0][2]).toEqual(["one.json"]);
    expect(io.git.mock.calls.every((call) => call[2].cwd === "/snapshot")).toBe(true);
    expect(io.git.mock.calls.at(-1)?.[1].at(-1)).toBe(".agents/pm/merge-receipts/one.json");
  });

  it.each(["empty", "absent", "non-receipt files"])("clears inherited namespace authority for an %s source", async (condition) => {
    if (condition === "empty") io.names.mockResolvedValue([]);
    else if (condition === "absent") io.names.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
    else io.names.mockResolvedValue(["notes.txt"]);
    await seedSnapshotReceiptIndex("/source", "/snapshot", "/source/state");
    expect(io.blobs).not.toHaveBeenCalled();
    expect(io.git).toHaveBeenCalledTimes(1);
    expect(io.input).toEqual([]);
  });

  it("propagates unreadable source evidence before any snapshot index mutation", async () => {
    io.names.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(seedSnapshotReceiptIndex("/source", "/snapshot", "/source/state")).rejects.toMatchObject({ code: "EACCES" });
    expect(io.git).not.toHaveBeenCalled();
  });

  it.each(["missing input", "broken input", "invalid object"])("fails closed for %s", async (mode) => {
    io.mode = mode;
    if (mode === "invalid object") io.git.mockResolvedValue({ stdout: "not-an-object-id" });
    await expect(seedSnapshotReceiptIndex("/source", "/snapshot", "/source/state")).rejects.toThrow();
    expect(io.killed).toHaveBeenCalledTimes(mode === "broken input" ? 1 : 0);
    expect(io.git.mock.calls.some((call) => call[1][0] === "update-index")).toBe(false);
  });
});
