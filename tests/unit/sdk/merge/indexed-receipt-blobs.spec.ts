/** Verify Git's index/object protocol and resource boundaries independently of receipt schemas. */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ git: vi.fn(), realpath: vi.fn(), inputs: [] as string[], brokenPipe: false, noStdin: false, kill: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => {
    // A native rejection must remain observable; a mock's async observer can absorb it.
    const pending = mocks.noStdin && (args[1] as string[])[0] === "cat-file" ? Promise.reject(new Error("Git spawn failed")) : mocks.git(...args);
    let onError: () => void;
    pending.child = { stdin: mocks.noStdin ? null : { on: (_event: string, listener: () => void) => { onError = listener; }, end: (input: string) => { mocks.inputs.push(input); if (mocks.brokenPipe) onError(); } }, kill: mocks.kill };
    return pending;
  } }),
}));
vi.mock("node:fs/promises", async (original) => ({ ...(await original()), realpath: mocks.realpath }));
import { readIndexedReceiptBlobs } from "../../../../src/sdk/merge/indexed-receipt-blobs.js";

const id = "a".repeat(40);
const second = "b".repeat(64);
const third = "c".repeat(40);
const directory = ".agents/pm/merge-receipts";
const body = "{\n\"value\":\"é\"\n}";
const bytes = Buffer.byteLength(body);
const listing = (oid = id, file = "one.json", stage = 0, mode = "100644") => `${mode} ${oid} ${stage}\t${directory}/${file}\0`;
const framed = (oid = id, value = body) => `${oid} blob ${Buffer.byteLength(value)}\n${value}\n`;
const read = (files = ["one.json"], limit = 1024) => readIndexedReceiptBlobs("/workspace", `/workspace/${directory}`, files, limit);

describe("indexed receipt blob batches", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.inputs = []; mocks.brokenPipe = false; mocks.noStdin = false; mocks.kill.mockReset();
    mocks.realpath.mockReset().mockImplementation(async (target) => target);
    mocks.git.mockReset().mockImplementation(async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "/workspace\n" : args[0] === "ls-files" ? listing() : Buffer.from(args[1] === "--batch-check" ? `${id} blob ${bytes}\n` : framed()) }));
  });

  it("reads exact UTF-8 bytes from indexed blobs and honors the selected index", async () => {
    vi.stubEnv("GIT_INDEX_FILE", "/selected/index");
    expect(await read()).toEqual(new Map([["one.json", body]]));
    expect(mocks.inputs).toEqual([`${id}\n`, `${id}\n`]);
    expect(mocks.git).toHaveBeenCalledWith("git", ["ls-files", "--stage", "-z", "--", `:(literal)${directory}/`], expect.objectContaining({ env: expect.objectContaining({ GIT_INDEX_FILE: path.resolve("/selected/index"), GIT_NO_REPLACE_OBJECTS: "1" }) }));
  });

  it.each(["missing workspace", "missing directory", "outside workspace", "empty index"])("provides no authority for %s", async (condition) => {
    if (condition === "missing workspace") mocks.git.mockRejectedValue(new Error("not a repository"));
    if (condition === "missing directory") mocks.realpath.mockRejectedValue(new Error("missing directory"));
    if (condition === "outside workspace") mocks.realpath.mockImplementation(async (target) => target === "/workspace" ? "/other" : target);
    if (condition === "empty index") mocks.git.mockImplementation(async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "/workspace\n" : "" }));
    expect(await read()).toEqual(new Map());
    expect(mocks.inputs).toEqual([]);
  });

  it("ignores symlink modes, conflict stages, malformed records and unrequested paths", async () => {
    const records = listing(id, "one.json", 1) + listing(id, "one.json", 0, "120000") + listing(id, "unrequested.json") + "malformed\0";
    mocks.git.mockImplementation(async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "/workspace\n" : records }));
    expect(await read()).toEqual(new Map());
  });

  it("skips missing, non-blob, oversized, unsafe-size and unrequested objects", async () => {
    mocks.git.mockImplementation(async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "/workspace\n" : args[0] === "ls-files" ? listing() : Buffer.from(`missing\n${id} missing\n${id} tree 5\n${id} blob 1025\n${id} blob 9007199254740992\n${second} blob 1\n`) }));
    expect(await read()).toEqual(new Map());
  });

  it("deduplicates object requests, splits byte-bounded batches and excludes unavailable blobs", async () => {
    const large = "x".repeat(300);
    let batches = 0;
    mocks.git.mockImplementation(async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "/workspace\n" : args[0] === "ls-files" ? listing() + listing(second, "two.json", 0, "100755") + listing(second, "copy.json") + listing(third, "missing.json") : Buffer.from(args[1] === "--batch-check" ? `${id} blob 300\n${second} blob 300\n${third} missing\n` : framed(batches++ === 0 ? id : second, large)) }));
    expect(await read(["one.json", "two.json", "copy.json", "missing.json"], 512)).toEqual(new Map([["one.json", large], ["two.json", large], ["copy.json", large]]));
    expect(mocks.inputs).toEqual([`${id}\n${second}\n${third}\n`, `${id}\n`, `${second}\n`]);
  });

  it.each(["missing header", "wrong header", "truncated bytes", "trailing bytes"])("refuses %s without partial authority", async (condition) => {
    const output = condition === "missing header" ? "no newline" : condition === "wrong header" ? framed(second) : condition === "truncated bytes" ? framed().slice(0, -1) : `${framed()}extra`;
    const original = mocks.git.getMockImplementation()!;
    mocks.git.mockImplementation(async (...args) => args[1][1] === "--batch" ? { stdout: Buffer.from(output) } : original(...args));
    expect(await read()).toEqual(new Map());
  });

  it.each([false, true])("refuses failed child input without leaking its rejection (missing pipe: %s)", async (missingPipe) => {
    mocks.brokenPipe = true;
    mocks.noStdin = missingPipe;
    const original = mocks.git.getMockImplementation()!;
    mocks.git.mockImplementation(async (...args) => { if (args[1][0] === "cat-file") throw new Error("broken input"); return original(...args); });
    expect(await read()).toEqual(new Map());
    expect(mocks.kill).toHaveBeenCalledTimes(missingPipe ? 0 : 1);
  });
});
