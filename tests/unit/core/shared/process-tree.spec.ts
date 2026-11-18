import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// pm-5kfzjh: the deadline teardown walks a provider's live descendants from a
// `ps -A -o pid= -o ppid=` snapshot, runs its helpers under a hard deadline,
// and never walks a PID that may have been reused.
const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn((file: string) => file === "/bin/ps"));
// No real /proc is read: a fake pid could belong to a real process on the host.
const readFileSyncMock = vi.hoisted(() => vi.fn((_file: string, _encoding?: string): string => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

const { ancestryStillMatches, descendantEntriesFromProcessTable, descendantsFromProcessTable, killProcessTree, parentStillMatches, processTableSharesNamespace, resolveTrustedPs, resolveWindowsSystemRoot, runTeardownHelper } = await import("../../../../src/core/shared/process-tree.js");

class FakeStream extends EventEmitter {
  readonly setEncoding = vi.fn();
  readonly destroy = vi.fn();
}

class FakeHelper extends EventEmitter {
  stdout: FakeStream | null = new FakeStream();
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
}

let helpers: FakeHelper[] = [];

/** Spawn fake helpers and drive each one once its listeners are attached. */
function provide(drive: (helper: FakeHelper) => void, withoutStdout = false): void {
  spawnMock.mockImplementation(() => {
    const helper = new FakeHelper();
    if (withoutStdout) helper.stdout = null;
    helpers.push(helper);
    queueMicrotask(() => drive(helper));
    return helper;
  });
}

function answer(stdout: string, code: number | null = 0): void {
  provide((helper) => {
    helper.stdout?.emit("data", stdout);
    helper.emit("close", code);
  });
}

function withPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  return () => Object.defineProperty(process, "platform", descriptor);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  spawnMock.mockReset();
  existsSyncMock.mockImplementation((file: string) => file === "/bin/ps");
  readFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  helpers = [];
});

describe("parentStillMatches", () => {
  it("reads the parent after the parenthesised command name, which may hold spaces and parentheses", () => {
    const stat = (ppid: number) => () => `4300 (a (b) c) S ${ppid} 4300 4300 0 -1 4194560`;
    expect(parentStillMatches({ pid: 4300, parent: 4242 }, stat(4242))).toBe(true);
    // A pid reused after the snapshot has another parent and is skipped.
    expect(parentStillMatches({ pid: 4300, parent: 4242 }, stat(1))).toBe(false);
  });

  it("skips a pid that vanished on a host with procfs and trusts the snapshot without procfs", () => {
    existsSyncMock.mockImplementation((file: string) => file === "/proc/self/stat");
    expect(parentStillMatches({ pid: 4300, parent: 4242 }, () => undefined)).toBe(false);
    existsSyncMock.mockImplementation(() => false);
    expect(parentStillMatches({ pid: 4300, parent: 4242 }, () => undefined)).toBe(true);
  });

  it("reads /proc/<pid>/stat by default", () => {
    readFileSyncMock.mockImplementation(() => "4300 (sleep) S 4242 1 1 0");
    expect(parentStillMatches({ pid: 4300, parent: 4242 })).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/4300/stat", "utf8");
  });
});

describe("ancestryStillMatches", () => {
  const parentOf = new Map([[200, 100], [300, 200]]);
  it("requires every link up to the root to keep its snapshot parent", () => {
    expect(ancestryStillMatches(300, 100, parentOf, () => true)).toBe(true);
    // The intermediate 200 was reused: its child 300 must not count as a descendant.
    expect(ancestryStillMatches(300, 100, parentOf, (entry) => entry.pid !== 200)).toBe(false);
    expect(ancestryStillMatches(400, 100, parentOf, () => true)).toBe(false);
    expect(ancestryStillMatches(100, 100, parentOf, () => false)).toBe(true);
  });
});

describe("processTableSharesNamespace", () => {
  it("trusts procfs only when NSpid holds this process's pid alone", () => {
    const status = (nspid: string | undefined) => () => `Name:\tnode\nPid:\t${process.pid}\n${nspid === undefined ? "" : `NSpid:\t${nspid}\n`}PPid:\t1\n`;
    expect(processTableSharesNamespace(status(`${process.pid}`))).toBe(true);
    // A /proc from an outer namespace lists this process in both namespaces,
    // even when the numbers happen to match.
    expect(processTableSharesNamespace(status(`${process.pid} ${process.pid}`))).toBe(false);
    expect(processTableSharesNamespace(status(`${process.pid + 1}`))).toBe(false);
    // A kernel without NSpid gives no evidence.
    expect(processTableSharesNamespace(status(undefined))).toBe(false);
    existsSyncMock.mockImplementation((file: string) => file === "/proc/self/status");
    expect(processTableSharesNamespace(() => undefined)).toBe(false);
    existsSyncMock.mockImplementation(() => false);
    expect(processTableSharesNamespace(() => undefined)).toBe(true);
    readFileSyncMock.mockImplementation(() => `NSpid:\t${process.pid}\n`);
    expect(processTableSharesNamespace()).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/self/status", "utf8");
  });

  it("skips the descendant walk when the process table is from another namespace", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        return true;
      });
      existsSyncMock.mockImplementation((file: string) => file === "/bin/ps" || file === "/proc/self/status");
      readFileSyncMock.mockImplementation(() => `NSpid:\t${process.pid}\t1\n`);
      const caller = { kill: vi.fn(), alive: vi.fn(() => true) };
      await killProcessTree(4242, caller);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
      expect(caller.kill).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});

describe("resolveWindowsSystemRoot", () => {
  it("matches the variable names case-insensitively, as a worker thread's env copy needs", () => {
    expect(resolveWindowsSystemRoot({ SYSTEMROOT: "C:\\Windows" })).toBe("C:\\Windows");
    expect(resolveWindowsSystemRoot({ WINDIR: "D:\\Windows" })).toBe("D:\\Windows");
  });

  it("accepts only a fully qualified drive path, from SystemRoot and then windir", () => {
    expect(resolveWindowsSystemRoot({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows");
    expect(resolveWindowsSystemRoot({ SystemRoot: "D:/WinRoot", windir: "C:\\Windows" })).toBe("D:/WinRoot");
    expect(resolveWindowsSystemRoot({ SystemRoot: "", windir: "C:\\Windows" })).toBe("C:\\Windows");
    for (const unsafe of ["", "Windows", ".\\Windows", "\\\\server\\share", "C:", "C:Windows"]) {
      expect(resolveWindowsSystemRoot({ SystemRoot: unsafe })).toBeUndefined();
    }
    expect(resolveWindowsSystemRoot({})).toBeUndefined();
  });
});

describe("resolveTrustedPs", () => {
  it("prefers /bin/ps, falls back to /usr/bin/ps and never searches PATH", () => {
    expect(resolveTrustedPs(() => true)).toBe("/bin/ps");
    expect(resolveTrustedPs((file) => file === "/usr/bin/ps")).toBe("/usr/bin/ps");
    expect(resolveTrustedPs(() => false)).toBeUndefined();
    existsSyncMock.mockImplementation(() => false);
    expect(resolveTrustedPs()).toBeUndefined();
  });
});

describe("descendantsFromProcessTable", () => {
  it("lists every live descendant deepest first", () => {
    const table = ["  100     1", "  200   100", "  300   200", "  301   200", "  400   100", "  500     1", ""].join("\n");
    // Breadth first from 100 is 200, 400, 300, 301; deepest first is its reverse.
    expect(descendantsFromProcessTable(table, 100)).toEqual([301, 300, 400, 200]);
  });

  it("returns nothing for a root without children or absent from the table", () => {
    expect(descendantsFromProcessTable("100 1\n200 1\n", 100)).toEqual([]);
    expect(descendantsFromProcessTable("100 1\n", 999)).toEqual([]);
    expect(descendantsFromProcessTable("", 100)).toEqual([]);
  });

  it("skips malformed rows and lists each process once even through a cycle", () => {
    const table = ["header row", "200 100 extra", "abc 100", "0 100", "-5 100", "200 100", "300 200", "200 300", "100 300", "9007199254740993 100"].join("\n");
    expect(descendantsFromProcessTable(table, 100)).toEqual([300, 200]);
  });

  it("stays linear for a host with very many sibling processes", () => {
    const rows = Array.from({ length: 30_000 }, (_unused, index) => `${10_000 + index} 1`);
    rows.push("200 100", "300 200");
    const started = performance.now();
    expect(descendantsFromProcessTable(rows.join("\n"), 100)).toEqual([300, 200]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("records the snapshot parent of each descendant", () => {
    expect(descendantEntriesFromProcessTable("200 100\n300 200\n301 100\n", 100)).toEqual([
      { pid: 300, parent: 200 },
      { pid: 301, parent: 100 },
      { pid: 200, parent: 100 },
    ]);
  });

  it("does not list a process re-parented away from the root", () => {
    // The launcher 100 exited, so its former helper 200 now belongs to init.
    expect(descendantsFromProcessTable("200 1\n300 200\n", 100)).toEqual([]);
  });
});

describe("runTeardownHelper", () => {
  it("collects the helper's stdout and exit code from a hidden, stdin- and stderr-free child", async () => {
    answer("1 0\n");
    expect(await runTeardownHelper("ps", ["-A"])).toEqual({ code: 0, stdout: "1 0\n" });
    expect(spawnMock).toHaveBeenCalledWith("ps", ["-A"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    expect(helpers[0]?.stdout?.setEncoding).toHaveBeenCalledWith("utf8");
  });

  it("resolves undefined when the helper cannot start, errors or has no stdout", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn EMFILE");
    });
    expect(await runTeardownHelper("ps", [])).toBeUndefined();
    provide((helper) => helper.emit("error", new Error("spawn ENOENT")));
    expect(await runTeardownHelper("ps", [])).toBeUndefined();
    provide((helper) => helper.emit("error", new Error("spawn EMFILE")), true);
    expect(await runTeardownHelper("ps", [])).toBeUndefined();
  });

  it("abandons a stalled helper at its hard deadline instead of waiting for its pipes", async () => {
    vi.useFakeTimers();
    provide(() => undefined);
    const pending = runTeardownHelper("ps", []);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(helpers[0]?.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeUndefined();
    expect(helpers[0]?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(helpers[0]?.stdout?.destroy).toHaveBeenCalled();
    // An abandoned helper never keeps the host running.
    expect(helpers[0]?.unref).toHaveBeenCalledTimes(1);
    // A late close changes nothing.
    helpers[0]?.emit("close", 0);
  });
});

describe("killProcessTree", () => {
  const root = () => ({ kill: vi.fn(), alive: vi.fn(() => true) });

  it("ignores a pid that cannot name a process", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const pid of [0, -1, 1.5, Number.NaN]) await killProcessTree(pid);
    expect(kill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("signals the process group of a detached child without listing processes", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const caller = root();
      await killProcessTree(4242, caller);
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(caller.kill).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("kills the live descendants deepest first, then the root through the caller", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw Object.assign(new Error("no group"), { code: "ESRCH" });
        if (pid === 4300) throw Object.assign(new Error("already gone"), { code: "ESRCH" });
        return true;
      });
      answer("4242 1\n4300 4242\n4301 4300\n9999 1\n");
      const events: string[] = [];
      kill.mockImplementation((pid) => {
        events.push(`kill ${String(pid)}`);
        if (pid === -4242) throw Object.assign(new Error("no group"), { code: "ESRCH" });
        // A descendant that already exited must not stop the walk.
        if (pid === 4300) throw Object.assign(new Error("already gone"), { code: "ESRCH" });
        return true;
      });
      const caller = { kill: vi.fn(() => events.push("root")), alive: vi.fn(() => true) };
      await killProcessTree(4242, caller);
      expect(spawnMock).toHaveBeenCalledWith("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid="], expect.objectContaining({ env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }));
      // Descendants deepest first, and the root last, so none is orphaned first.
      expect(events).toEqual(["kill -4242", "kill 4301", "kill 4300", "root"]);
      expect(caller.alive).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("skips a descendant whose parent no longer matches the snapshot", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        return true;
      });
      existsSyncMock.mockImplementation((file: string) => file === "/bin/ps" || file === "/proc/self/stat" || file === "/proc/self/status");
      // 4300 still belongs to the root; 4301 was reused by a process of init.
      readFileSyncMock.mockImplementation((file: string) => {
        if (file === "/proc/self/status") return `NSpid:\t${process.pid}\n`;
        return file === "/proc/4300/stat" ? "4300 (sleep) S 4242 0" : "4301 (other) S 1 0";
      });
      answer("4300 4242\n4301 4242\n");
      const caller = root();
      await killProcessTree(4242, caller);
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"], [4300, "SIGKILL"]]);
      expect(caller.kill).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("skips a grandchild whose intermediate parent was reused after the snapshot", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        return true;
      });
      existsSyncMock.mockImplementation((file: string) => file === "/bin/ps" || file === "/proc/self/stat" || file === "/proc/self/status");
      readFileSyncMock.mockImplementation((file: string) => {
        if (file === "/proc/self/status") return `NSpid:\t${process.pid}\n`;
        // 4400 still names 4300 as its parent, but 4300 now belongs to init.
        return file === "/proc/4400/stat" ? "4400 (helper) S 4300 0" : "4300 (other) S 1 0";
      });
      answer("4300 4242\n4400 4300\n");
      await killProcessTree(4242, root());
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
    } finally {
      restore();
    }
  });

  it("discards the snapshot when the root exited while ps ran, so a reused pid is never walked", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        return true;
      });
      // The root is alive when teardown starts and exits while ps runs.
      let rootAlive = true;
      provide((helper) => {
        helper.stdout?.emit("data", "4300 4242\n");
        rootAlive = false;
        helper.emit("close", 0);
      });
      const caller = { kill: vi.fn(), alive: vi.fn(() => rootAlive) };
      await killProcessTree(4242, caller);
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
      expect(caller.kill).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it.each([
    ["exits with a failure", (helper: FakeHelper) => { helper.stdout?.emit("data", "4300 4242\n"); helper.emit("close", 1); }],
    ["is not installed in a trusted location", undefined],
  ])("kills only the root when the system ps %s", async (_label, drive) => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        return true;
      });
      if (drive) provide(drive);
      else existsSyncMock.mockImplementation(() => false);
      const caller = root();
      await killProcessTree(4242, caller);
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"]]);
      expect(spawnMock).toHaveBeenCalledTimes(drive ? 1 : 0);
      expect(caller.kill).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("walks the snapshot and kills the root by pid when no caller root is given", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        return true;
      });
      answer("4300 4242\n");
      await killProcessTree(4242);
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"], [4300, "SIGKILL"], [4242, "SIGKILL"]]);
    } finally {
      restore();
    }
  });

  it("kills only the root when ps cannot run, and by pid without a caller", async () => {
    const restore = withPlatform("linux");
    try {
      const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
        if (pid === -4242) throw new Error("no group");
        if (pid === 4242) throw new Error("already gone");
        return true;
      });
      provide((helper) => helper.emit("error", new Error("spawn ENOENT")));
      await killProcessTree(4242);
      expect(kill.mock.calls).toEqual([[-4242, "SIGKILL"], [4242, "SIGKILL"]]);
    } finally {
      restore();
    }
  });

  it.each([
    ["succeeds", 0, false],
    ["fails", 128, true],
  ])("runs the System32 taskkill on Windows and kills the root when it %s", async (_label, code, rootKilled) => {
    const restore = withPlatform("win32");
    try {
      vi.stubEnv("SystemRoot", "D:\\WinRoot");
      answer("", code);
      const caller = root();
      await killProcessTree(4242, caller);
      expect(spawnMock).toHaveBeenCalledWith(path.win32.join("D:\\WinRoot", "System32", "taskkill.exe"), ["/pid", "4242", "/T", "/F"], expect.anything());
      expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty("env");
      expect(caller.kill).toHaveBeenCalledTimes(rootKilled ? 1 : 0);
    } finally {
      restore();
    }
  });

  it("does not kill a Windows root by its possibly reused PID once it exited while taskkill ran", async () => {
    const restore = withPlatform("win32");
    try {
      vi.stubEnv("SystemRoot", "C:\\Windows");
      // The root is alive when taskkill starts and exits while it runs.
      let rootAlive = true;
      provide((helper) => {
        rootAlive = false;
        helper.emit("close", 128);
      });
      const caller = { kill: vi.fn(), alive: vi.fn(() => rootAlive) };
      await killProcessTree(4242, caller);
      expect(caller.alive).toHaveBeenCalled();
      expect(caller.kill).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("uses windir when SystemRoot is not fully qualified, and kills the root when taskkill cannot run", async () => {
    const restore = withPlatform("win32");
    try {
      vi.stubEnv("SystemRoot", "Windows");
      vi.stubEnv("windir", "C:\\Windows");
      provide((helper) => helper.emit("error", new Error("spawn ENOENT")));
      const caller = root();
      await killProcessTree(4242, caller);
      expect(spawnMock.mock.calls[0]?.[0]).toBe(path.win32.join("C:\\Windows", "System32", "taskkill.exe"));
      expect(caller.kill).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("never guesses a taskkill path without a fully qualified system directory", async () => {
    const restore = withPlatform("win32");
    try {
      vi.stubEnv("SystemRoot", "");
      vi.stubEnv("windir", undefined);
      const caller = root();
      await killProcessTree(4242, caller);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(caller.kill).toHaveBeenCalledTimes(1);
      caller.kill.mockClear();
      caller.alive.mockReturnValue(false);
      await killProcessTree(4242, caller);
      expect(caller.kill).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
