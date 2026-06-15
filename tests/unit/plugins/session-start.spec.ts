import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const SESSION_START_PATH = "plugins/pm-claude/hooks/session-start.mjs";

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function importHook(queryPrefix: string): Promise<unknown> {
  const absolutePath = path.join(process.cwd(), SESSION_START_PATH);
  return import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`);
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${String(code ?? "")}`);
  }) as never);
}

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("plugins/pm-claude session-start hook", () => {
  it("exits silently when pm is not initialized in the workspace", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => false) }));
    const exec = vi.fn();
    vi.doMock("node:child_process", () => ({ execSync: exec }));
    const exit = mockExit();
    await expect(importHook("noSettings")).rejects.toThrow("EXIT:0");
    expect(exec).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("writes a tracker summary with top items when context is available", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() =>
        JSON.stringify({
          summary: { in_progress: 1, open: 2, blocked: 1 },
          high_level: [{ id: "pm-1", title: "High", status: "open" }],
          low_level: [{ id: "pm-2", title: "Low", status: "in_progress" }],
        }),
      ),
    }));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = mockExit();
    await expect(importHook("output")).resolves.toBeDefined();
    expect(exit).not.toHaveBeenCalled();
    const written = String(writeSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(written).toContain("pm tracker: 1 in_progress, 2 open, 1 BLOCKED");
    expect(written).toContain("[pm-1] High");
    exit.mockRestore();
    writeSpy.mockRestore();
  });

  it("writes a summary with no item lines when high/low level lists are absent (lines 31/38)", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() =>
        // counts present but no high_level/low_level keys: exercises the `?? []`
        // defaults (line 31) and the falsy itemLines arm of the template (line 38)
        JSON.stringify({ summary: { in_progress: 2, open: 0, blocked: 0 } }),
      ),
    }));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = mockExit();
    await expect(importHook("noItems")).resolves.toBeDefined();
    expect(exit).not.toHaveBeenCalled();
    const written = String(writeSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(written).toContain("pm tracker: 2 in_progress");
    expect(written).not.toContain("•");
    expect(written).toContain("Use pm_context tool or /pm-status for full details.");
    exit.mockRestore();
    writeSpy.mockRestore();
  });

  it("emits nothing when the context payload has no summary (line 22)", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("node:child_process", () => ({
      // ctx is truthy but summary is absent: exercises `if (!summary) return null`
      execSync: vi.fn(() => JSON.stringify({ high_level: [], low_level: [] })),
    }));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = mockExit();
    await expect(importHook("noSummary")).resolves.toBeDefined();
    expect(exit).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    exit.mockRestore();
    writeSpy.mockRestore();
  });

  it("emits nothing when all summary counts are zero", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() =>
        JSON.stringify({ summary: { in_progress: 0, open: 0, blocked: 0 }, high_level: [], low_level: [] }),
      ),
    }));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = mockExit();
    await expect(importHook("zeroSummary")).resolves.toBeDefined();
    expect(exit).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    exit.mockRestore();
    writeSpy.mockRestore();
  });

  it("exits silently when the pm context subprocess fails", async () => {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() => {
        throw new Error("npx failed");
      }),
    }));
    const exit = mockExit();
    await expect(importHook("contextFailure")).rejects.toThrow("EXIT:0");
    exit.mockRestore();
  });
});
