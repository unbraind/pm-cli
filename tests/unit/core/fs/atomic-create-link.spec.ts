/** createFileAtomic types a filesystem without hard links and never misreports a published file. */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ link: vi.fn(), rm: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (...args: Parameters<typeof actual.link>) => fsMocks.link(actual, ...args),
    rm: (...args: Parameters<typeof actual.rm>) => fsMocks.rm(actual, ...args),
  };
});
const { AtomicLinkUnsupportedError, createFileAtomic } = await import("../../../../src/core/fs/atomic-create.js");

describe("atomic publication on unusual filesystems", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "pm-seed-link-"));
    fsMocks.link.mockImplementation((actual, ...args) => actual.link(...args));
    fsMocks.rm.mockImplementation((actual, ...args) => actual.rm(...args));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm(root, { recursive: true, force: true });
  });

  it("types an unsupported hard link and passes other link failures through", async () => {
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
      fsMocks.link.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const error = await createFileAtomic(path.join(root, `${code}.json`), "x").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AtomicLinkUnsupportedError);
      expect(error).toMatchObject({ code, name: "AtomicLinkUnsupportedError" });
    }
    fsMocks.link.mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    await expect(createFileAtomic(path.join(root, "denied.json"), "x")).rejects.toMatchObject({ code: "EACCES" });
    fsMocks.link.mockRejectedValueOnce(new Error("no code"));
    await expect(createFileAtomic(path.join(root, "bare.json"), "x")).rejects.toThrow("no code");
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a published file even when staging cleanup fails", async () => {
    fsMocks.rm.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    const target = path.join(root, "stream.jsonl");
    await expect(createFileAtomic(target, "kept\n", { sync: true })).resolves.toBe(true);
    expect(await readFile(target, "utf8")).toBe("kept\n");
  });
});
