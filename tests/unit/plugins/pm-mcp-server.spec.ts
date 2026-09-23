import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as FsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const scripts = [
  "plugins/pm-claude/scripts/pm-mcp-server.mjs",
  "plugins/pm-codex/scripts/pm-mcp-server.mjs",
];
const originalOverride = process.env.PM_CLI_MCP_SERVER;
let sequence = 0;

/** Import each launcher as a fresh process entry while intercepting its child. */
async function launch(script: string, readable: (candidate: string) => boolean, checkoutVersion?: string) {
  const child = new EventEmitter();
  const spawn = vi.fn(() => child);
  vi.doMock("node:child_process", () => ({ spawn }));
  vi.doMock("node:fs/promises", async (load) => {
    const actual = await load<typeof FsPromises>();
    return {
      ...actual,
      access: vi.fn(async (candidate: string) => {
        if (!readable(String(candidate))) throw new Error("ENOENT");
      }),
      readFile: vi.fn(async (candidate: string) => {
        if (candidate === path.join(process.cwd(), "package.json") && checkoutVersion) {
          return JSON.stringify({ name: "@unbrained/pm-cli", version: checkoutVersion });
        }
        return actual.readFile(candidate, "utf8");
      }),
    };
  });
  for (const plugin of ["pm-claude", "pm-codex"]) {
    vi.doMock(path.join(process.cwd(), "plugins", plugin, "scripts", "plugin-runtime.mjs"), () => ({
      resolvePluginRuntime: vi.fn(async () => ({ server: "/cache/exact-version/server.js" })),
    }));
  }
  const url = pathToFileURL(path.join(process.cwd(), script)).href;
  await vi.importActual(`${url}?launch=${sequence++}`);
  return { child, spawn };
}

afterEach(() => {
  if (originalOverride === undefined) delete process.env.PM_CLI_MCP_SERVER;
  else process.env.PM_CLI_MCP_SERVER = originalOverride;
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs/promises");
  for (const plugin of ["pm-claude", "pm-codex"]) {
    vi.doUnmock(path.join(process.cwd(), "plugins", plugin, "scripts", "plugin-runtime.mjs"));
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("cached plugin MCP launchers", () => {
  it("starts an explicit local server without a shell", async () => {
    const target = path.join(os.tmpdir(), "explicit-pm-server.js");
    process.env.PM_CLI_MCP_SERVER = target;
    for (const script of scripts) {
      const { spawn } = await launch(script, (candidate) => candidate === target);
      expect(spawn).toHaveBeenCalledWith(process.execPath, [target], expect.objectContaining({ stdio: "inherit" }));
      expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty("shell");
    }
  });

  it("accepts a file URL override", async () => {
    const target = path.join(os.tmpdir(), "url-pm-server.js");
    process.env.PM_CLI_MCP_SERVER = pathToFileURL(target).href;
    for (const script of scripts) {
      const { spawn } = await launch(script, (candidate) => candidate === target);
      expect(spawn).toHaveBeenCalledWith(process.execPath, [target], expect.any(Object));
    }
  });

  it("fails closed when an explicit server is missing", async () => {
    process.env.PM_CLI_MCP_SERVER = "/tmp/missing-pm-server.js";
    for (const script of scripts) {
      await expect(launch(script, () => false)).rejects.toThrow("ENOENT");
    }
  });

  it("uses the repository server from a checkout", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const target = path.join(process.cwd(), "dist/mcp/server.js");
    for (const script of scripts) {
      const { spawn } = await launch(script, (candidate) => candidate === target);
      expect(spawn).toHaveBeenCalledWith(process.execPath, [target], expect.any(Object));
    }
  });

  it("refuses a checkout build whose version differs from the plugin", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    const target = path.join(process.cwd(), "dist/mcp/server.js");
    for (const script of scripts) {
      const { spawn } = await launch(script, (candidate) => candidate === target, "2026.9.21");
      expect(spawn).toHaveBeenCalledWith(process.execPath, ["/cache/exact-version/server.js"], expect.any(Object));
    }
  });

  it("uses the exact-version cached server when no checkout is present", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    for (const script of scripts) {
      const { spawn } = await launch(script, () => false);
      expect(spawn).toHaveBeenCalledWith(process.execPath, ["/cache/exact-version/server.js"], expect.any(Object));
    }
  });

  it("forwards exit codes, process errors, and termination signals", async () => {
    delete process.env.PM_CLI_MCP_SERVER;
    for (const script of scripts) {
      const { child } = await launch(script, () => false);
      child.emit("exit", 7, null);
      expect(process.exitCode).toBe(7);
      child.emit("error", new Error("cannot spawn"));
      expect(process.exitCode).toBe(1);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      child.emit("exit", null, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
      kill.mockRestore();
      child.emit("exit", null, null);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
  });
});
