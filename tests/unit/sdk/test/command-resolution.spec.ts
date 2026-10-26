import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => mocks.execute(...args) }));
import { detectLinkedTestCommandNotFound } from "../../../../src/sdk/test/command-resolution.js";

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetAllMocks();
});

describe("shell lookup evidence", () => {
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
