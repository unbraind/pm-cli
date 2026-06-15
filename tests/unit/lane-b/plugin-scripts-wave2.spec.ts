import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PM_MCP_SERVER = process.env.PM_CLI_MCP_SERVER;
const tempRoots: string[] = [];

const mcpServerScripts = [
  "plugins/pm-claude/scripts/pm-mcp-server.mjs",
  "plugins/pm-codex/scripts/pm-mcp-server.mjs",
] as const;

function cacheBustToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function importRepoModule<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

afterEach(async () => {
  if (ORIGINAL_PM_MCP_SERVER === undefined) {
    delete process.env.PM_CLI_MCP_SERVER;
  } else {
    process.env.PM_CLI_MCP_SERVER = ORIGINAL_PM_MCP_SERVER;
  }

  delete (globalThis as Record<string, unknown>).__PM_WAVE2_MCP_STARTS;
  delete (globalThis as Record<string, unknown>).__PM_WAVE2_MCP_MODULE_LOADS;
  delete (globalThis as Record<string, unknown>).__PM_WAVE2_REPO_SERVER_STARTS;

  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();

  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("lane-b plugin scripts", () => {
  it("covers session-start hook branches for missing settings, formatted output, and context failures", async () => {
    const sessionStartPath = "plugins/pm-claude/hooks/session-start.mjs";

    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
    }));
    const noSettingsExec = vi.fn();
    vi.doMock("node:child_process", () => ({ execSync: noSettingsExec }));
    const noSettingsExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);
    await expect(importRepoModule(sessionStartPath, "sessionNoSettings")).rejects.toThrow("EXIT:0");
    expect(noSettingsExec).not.toHaveBeenCalled();
    noSettingsExit.mockRestore();

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
    }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() =>
        JSON.stringify({
          summary: { in_progress: 1, open: 2, blocked: 1 },
          high_level: [{ id: "pm-1", title: "Lane-B high", status: "open" }],
          low_level: [{ id: "pm-2", title: "Lane-B low", status: "in_progress" }],
        }),
      ),
    }));
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const outputExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);
    await expect(importRepoModule(sessionStartPath, "sessionOutput")).resolves.toBeDefined();
    expect(outputExit).not.toHaveBeenCalled();
    expect(String(writeSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("pm tracker: 1 in_progress, 2 open, 1 BLOCKED");
    expect(String(writeSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("[pm-1] Lane-B high");
    outputExit.mockRestore();
    writeSpy.mockRestore();

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
    }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() =>
        JSON.stringify({
          summary: { in_progress: 0, open: 0, blocked: 0 },
          high_level: [],
          low_level: [],
        }),
      ),
    }));
    const noSummaryWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const noSummaryExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);
    await expect(importRepoModule(sessionStartPath, "sessionNoSummary")).resolves.toBeDefined();
    expect(noSummaryExit).not.toHaveBeenCalled();
    expect(noSummaryWriteSpy).not.toHaveBeenCalled();
    noSummaryExit.mockRestore();
    noSummaryWriteSpy.mockRestore();

    vi.resetModules();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
    }));
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() => {
        throw new Error("npx failed");
      }),
    }));
    const failedContextExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);
    await expect(importRepoModule(sessionStartPath, "sessionContextFailure")).rejects.toThrow("EXIT:0");
    failedContextExit.mockRestore();
  });

  it("covers MCP server wrappers explicit path and spawn fallback for both plugins", async () => {
    const root = await createTempRoot("pm-wave2-plugin-mcp-");
    const explicitServerPath = path.join(root, "explicit-server.mjs");
    await writeFile(
      explicitServerPath,
      `globalThis.__PM_WAVE2_MCP_MODULE_LOADS = (globalThis.__PM_WAVE2_MCP_MODULE_LOADS ?? 0) + 1;
export function startMcpServer() {
  globalThis.__PM_WAVE2_MCP_STARTS = (globalThis.__PM_WAVE2_MCP_STARTS ?? 0) + 1;
}
`,
      "utf8",
    );

    process.env.PM_CLI_MCP_SERVER = explicitServerPath;
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async (target: string) => {
        if (path.resolve(target) === path.resolve(explicitServerPath)) {
          return;
        }
        throw new Error("ENOENT");
      }),
    }));

    for (const script of mcpServerScripts) {
      await importRepoModule(script, `mcpExplicit-${path.basename(script)}`);
    }
    expect((globalThis as Record<string, unknown>).__PM_WAVE2_MCP_STARTS).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();

    vi.resetModules();
    delete process.env.PM_CLI_MCP_SERVER;
    const fallbackSpawn = vi.fn(() => {
      const child = {
        on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
          if (event === "exit") {
            handler(0, null);
          }
          return child;
        }),
      };
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn: fallbackSpawn }));
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    }));
    const fallbackExit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);
    for (const script of mcpServerScripts) {
      await expect(importRepoModule(script, `mcpFallback-${path.basename(script)}`)).rejects.toThrow("EXIT:0");
    }
    expect(fallbackSpawn).toHaveBeenCalledTimes(2);
    fallbackExit.mockRestore();
  });

  it("covers MCP wrapper repo-server discovery branch for both plugins", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    vi.doUnmock("node:fs/promises");
    const root = await createTempRoot("pm-wave2-plugin-repo-server-");
    const mockRepoServerPath = path.join(root, "mock-repo-server.mjs");
    await writeFile(
      mockRepoServerPath,
      `export function startMcpServer() {
  globalThis.__PM_WAVE2_REPO_SERVER_STARTS = (globalThis.__PM_WAVE2_REPO_SERVER_STARTS ?? 0) + 1;
}
`,
      "utf8",
    );
    const realRepoServerPath = path.join(process.cwd(), "dist", "mcp", "server.js");

    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async (target: string) => {
        if (path.resolve(target) === path.resolve(realRepoServerPath)) {
          return;
        }
        throw new Error("ENOENT");
      }),
    }));
    vi.doMock("node:url", async () => {
      const actual = await vi.importActual<typeof import("node:url")>("node:url");
      return {
        ...actual,
        pathToFileURL(target: string) {
          if (path.resolve(target) === path.resolve(realRepoServerPath)) {
            return actual.pathToFileURL(mockRepoServerPath);
          }
          return actual.pathToFileURL(target);
        },
      };
    });

    const repoSpawn = vi.fn();
    vi.doMock("node:child_process", () => ({ spawn: repoSpawn }));
    for (const script of mcpServerScripts) {
      await importRepoModule(script, `mcpRepoServer-${path.basename(script)}`);
    }
    expect((globalThis as Record<string, unknown>).__PM_WAVE2_REPO_SERVER_STARTS).toBe(2);
    expect(repoSpawn).not.toHaveBeenCalled();
  });

  it("covers MCP wrapper signal-forwarding branch", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    }));
    const signalSpawn = vi.fn(() => {
      const child = {
        on: vi.fn((event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
          if (event === "exit") {
            handler(null, "SIGTERM");
          }
          return child;
        }),
      };
      return child;
    });
    vi.doMock("node:child_process", () => ({ spawn: signalSpawn }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${String(code ?? "")}`);
    }) as never);

    for (const script of mcpServerScripts) {
      await expect(importRepoModule(script, `mcpSignal-${path.basename(script)}`)).resolves.toBeDefined();
    }
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
