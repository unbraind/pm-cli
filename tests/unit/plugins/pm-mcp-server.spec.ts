import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function importScript<T>(relativePath: string, queryPrefix: string): Promise<T> {
  const absolutePath = path.join(process.cwd(), relativePath);
  return (await import(`${pathToFileURL(absolutePath).href}?${queryPrefix}=${cacheBustToken()}`)) as T;
}

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${String(code ?? "")}`);
  }) as never);
}

function spawnReturningExit(code: number | null, signal: NodeJS.Signals | null) {
  return vi.fn(() => {
    const child = {
      on: vi.fn((event: string, handler: (c: number | null, s: NodeJS.Signals | null) => void) => {
        if (event === "exit") {
          handler(code, signal);
        }
        return child;
      }),
    };
    return child;
  });
}

afterEach(async () => {
  if (ORIGINAL_PM_MCP_SERVER === undefined) {
    delete process.env.PM_CLI_MCP_SERVER;
  } else {
    process.env.PM_CLI_MCP_SERVER = ORIGINAL_PM_MCP_SERVER;
  }
  delete (globalThis as Record<string, unknown>).__PM_MCP_STARTS;
  delete (globalThis as Record<string, unknown>).__PM_MCP_MODULE_LOADS;
  delete (globalThis as Record<string, unknown>).__PM_REPO_SERVER_STARTS;
  vi.doUnmock("node:fs/promises");
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:url");
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("plugins pm-mcp-server wrappers", () => {
  it("imports and starts an explicit server path for both plugins", async () => {
    const root = await createTempRoot("pm-plugin-mcp-explicit-");
    const explicitServerPath = path.join(root, "explicit-server.mjs");
    await writeFile(
      explicitServerPath,
      `globalThis.__PM_MCP_MODULE_LOADS = (globalThis.__PM_MCP_MODULE_LOADS ?? 0) + 1;
export function startMcpServer() {
  globalThis.__PM_MCP_STARTS = (globalThis.__PM_MCP_STARTS ?? 0) + 1;
}
`,
      "utf8",
    );
    process.env.PM_CLI_MCP_SERVER = explicitServerPath;
    const spawnMock = vi.fn();
    const accessMock = vi.fn(async (target: string) => {
      if (path.resolve(target) === path.resolve(explicitServerPath)) {
        return;
      }
      throw new Error("ENOENT");
    });
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.doMock("node:fs/promises", () => ({
      access: accessMock,
    }));
    for (const script of mcpServerScripts) {
      await importScript(script, `explicit-${path.basename(script)}`);
    }
    expect((globalThis as Record<string, unknown>).__PM_MCP_STARTS).toBe(2);
    expect(accessMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("discovers and starts the repo-checkout server when no explicit path is set", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const root = await createTempRoot("pm-plugin-mcp-repo-");
    const mockRepoServerPath = path.join(root, "mock-repo-server.mjs");
    await writeFile(
      mockRepoServerPath,
      `export function startMcpServer() {
  globalThis.__PM_REPO_SERVER_STARTS = (globalThis.__PM_REPO_SERVER_STARTS ?? 0) + 1;
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
      await importScript(script, `repo-${path.basename(script)}`);
    }
    expect((globalThis as Record<string, unknown>).__PM_REPO_SERVER_STARTS).toBe(2);
    expect(repoSpawn).not.toHaveBeenCalled();
  });

  it("spawns the npx fallback and forwards the child exit code", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const fallbackSpawn = spawnReturningExit(0, null);
    vi.doMock("node:child_process", () => ({ spawn: fallbackSpawn }));
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    }));
    const exit = mockExit();
    for (const script of mcpServerScripts) {
      await expect(importScript(script, `fallback-${path.basename(script)}`)).rejects.toThrow("EXIT:0");
    }
    expect(fallbackSpawn).toHaveBeenCalledTimes(2);
    exit.mockRestore();
  });

  it("uses the npx fallback when Codex repo discovery reaches the depth limit", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const fallbackSpawn = spawnReturningExit(0, null);
    vi.doMock("node:child_process", () => ({ spawn: fallbackSpawn }));
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    }));
    vi.doMock("node:path", async () => {
      const actual = await vi.importActual<typeof import("node:path")>("node:path");
      let depth = 0;
      const dirname = vi.fn(() => `/virtual-parent-${depth++}`);
      return { ...actual, default: { ...actual.default, dirname }, dirname };
    });
    const exit = mockExit();

    await expect(importScript("plugins/pm-codex/scripts/pm-mcp-server.mjs", "fallback-depth-limit")).rejects.toThrow("EXIT:0");

    expect(fallbackSpawn).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });

  it("exits with code 1 when the spawned child reports a null exit code (line 62)", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const nullCodeSpawn = spawnReturningExit(null, null);
    vi.doMock("node:child_process", () => ({ spawn: nullCodeSpawn }));
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    }));
    const exit = mockExit();
    for (const script of mcpServerScripts) {
      await expect(importScript(script, `nullcode-${path.basename(script)}`)).rejects.toThrow("EXIT:1");
    }
    expect(nullCodeSpawn).toHaveBeenCalledTimes(2);
    exit.mockRestore();
  });

  it("forwards a termination signal instead of exiting", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const signalSpawn = spawnReturningExit(null, "SIGTERM");
    vi.doMock("node:child_process", () => ({ spawn: signalSpawn }));
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const exit = mockExit();
    for (const script of mcpServerScripts) {
      await expect(importScript(script, `signal-${path.basename(script)}`)).resolves.toBeDefined();
    }
    expect(killSpy).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    killSpy.mockRestore();
    exit.mockRestore();
  });
});
