import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), open: vi.fn(), read: vi.fn(), close: vi.fn(), access: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {}, {
  [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => new Promise((resolve, reject) => {
    mocks.execute(...args, (error: unknown, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
  }),
}) }));
vi.mock("node:fs/promises", () => ({ open: (...args: unknown[]) => mocks.open(...args), access: (...args: unknown[]) => mocks.access(...args) }));
import { detectLinkedTestCommandNotFound } from "../../../../src/sdk/test/command-resolution.js";

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetAllMocks();
});

describe("shell lookup evidence", () => {
  it.each([
    ["./script", "#!/absent/interpreter\nexit 0", "ENOENT", true],
    ["./script", "#! \t/absent/interpreter --flag\n", "ENOENT", true],
    ["./script", "#!/present/interpreter", null, false],
    ["./script", "#!/unreadable/interpreter\n", "EACCES", false],
    ["./script", "#!/uncertain/interpreter\n", undefined, false],
    ["./script", "#!relative-interpreter\n", "ENOENT", false],
    ["./script", "ordinary binary", "ENOENT", false],
    ["./script", `#!/${"x".repeat(300)}`, "ENOENT", false],
    ["./script", `#!/absent/interpreter\n${"x".repeat(300)}`, "ENOENT", true],
    ["", "#!/absent/interpreter\n", "ENOENT", false],
    ["./script\n./another-script", "#!/absent/interpreter\n", "ENOENT", false],
  ])("corroborates the resolved script header %s conservatively", async (resolved, header, code, expected) => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mocks.execute.mockImplementation((_file, _args, _options, callback) => callback(null, `${resolved}\n`, ""));
    mocks.open.mockResolvedValue({ read: mocks.read, close: mocks.close });
    mocks.read.mockImplementation((buffer: Buffer) => Promise.resolve({ bytesRead: buffer.write(header) }));
    if (code !== null) mocks.access.mockRejectedValue(Object.assign(new Error("unavailable"), { code }));
    expect(await detectLinkedTestCommandNotFound("./script", { exitCode: 127, stderr: "/bin/sh: 1: ./script: not found" }, {}, "/tmp/lookup-test")).toBe(expected);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    if (resolved && !resolved.includes("\n")) expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it.each(["open", "read", "close"] as const)("declines unavailable script evidence when %s fails", async (stage) => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mocks.execute.mockImplementation((_file, _args, _options, callback) => callback(null, "./script\n", ""));
    mocks.open.mockResolvedValue({ read: mocks.read, close: mocks.close });
    mocks.read.mockResolvedValue({ bytesRead: 0 });
    mocks[stage].mockRejectedValue(Object.assign(new Error("unavailable"), { code: "ENOENT" }));
    expect(await detectLinkedTestCommandNotFound("./script", { exitCode: 127, stderr: "/bin/sh: 1: ./script: not found" }, {}, "/tmp/lookup-test")).toBe(false);
    expect(mocks.access).not.toHaveBeenCalled();
    if (stage !== "open") expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["win32", "missing-tool", 127, "'missing-tool' is not recognized as an internal or external command,"],
    ["win32", "missing-tool", 1, "ENOENT: not found"],
  ])("declines unrecognized Windows status or diagnostics", async (platform, command, exitCode, stderr) => {
    Object.defineProperty(process, "platform", { value: platform });
    expect(await detectLinkedTestCommandNotFound(command, { exitCode, stderr }, {}, "/tmp/lookup-test")).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", "missing-tool", 127, "/bin/sh: 1: missing-tool: not found", 1, true],
    ["linux", "'missing-tool'", 127, "/bin/sh: 1: missing-tool: command not found", 127, true],
    ["linux", '"missing tool"', 127, "/bin/sh: 1: missing tool: not found", 1, true],
    ["linux", "node", 127, "/bin/sh: 1: node: not found", null, false],
    ["linux", "missing-tool", 127, "/bin/sh: 1: missing-tool: not found", "ENOENT", false],
    ["linux", "missing-tool", 127, "/bin/sh: 1: missing-tool: not found", "ETIMEDOUT", false],
    ["linux", "missing-tool", 127, "/bin/sh: 1: missing-tool: not found", 2, false],
    ["win32", "missing-tool", 1, "'missing-tool' is not recognized as an internal or external command,\r\noperable program or batch file.", 1, true],
    ["win32", "missing-tool", 9009, "'missing-tool' is not recognized as an internal or external command,", 1, true],
    ["win32", "node", 1, "'node' is not recognized as an internal or external command,", null, false],
    ["win32", "node", 9009, "'node' is not recognized as an internal or external command,", null, false],
    ["win32", "missing-tool", 1, "'missing-tool' is not recognized as an internal or external command,", 127, false],
  ])("certifies %s lookup for %s only from the resolver outcome", async (platform, command, exitCode, stderr, code, expected) => {
    Object.defineProperty(process, "platform", { value: platform });
    mocks.execute.mockImplementation((_file, _args, _options, callback) => callback(code === null ? null : Object.assign(new Error("lookup failed"), { code }), "", ""));
    const env = platform === "win32" && code === 127 ? { SystemRoot: "C:\\Test" } : {};
    expect(await detectLinkedTestCommandNotFound(command, { exitCode, stderr }, env, "/tmp/lookup-test")).toBe(expected);
    expect(mocks.execute).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cwd: "/tmp/lookup-test", timeout: 1_000 }), expect.any(Function));
  });

  it.each([
    ["$TOOL", 127, "/bin/sh: 1: missing-tool: not found"],
    ["PATH=elsewhere missing-tool", 127, "/bin/sh: 1: missing-tool: not found"],
    ["missing-tool && exit 127", 127, "/bin/sh: 1: missing-tool: not found"],
    ["\"%TOOL%\"", 127, "/bin/sh: 1: missing-tool: not found"],
    ["missing-tool", 1, "ENOENT: not found"],
    ["node", 127, "/bin/sh: 1: another-command: not found"],
    ["missing-tool", 127, "missing-tool: not found"],
  ])("retains unproven failure semantics for %s", async (command, exitCode, stderr) => {
    expect(await detectLinkedTestCommandNotFound(command, { exitCode, stderr }, { SystemRoot: "C:\\Test" }, "/tmp/lookup-test")).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
