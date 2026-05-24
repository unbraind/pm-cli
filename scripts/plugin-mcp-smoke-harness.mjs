/**
 * Shared smoke harness for the plugin MCP launchers.
 *
 * Both scripts/smoke-claude-plugin.mjs and scripts/smoke-codex-plugin-mcp.mjs
 * spawn a stdio MCP server, speak JSON-RPC over stdin/stdout, list tools, and
 * drive an identical pm_run(init) → create → claim → update → comments → files →
 * docs → test → get → context workflow in a sandbox. This module owns the
 * spawn / JSON-RPC / readiness / cleanup plumbing they shared verbatim.
 *
 * NOTE: this helper lives under scripts/ and is imported only by the repo smoke
 * scripts (which run from the repo root). It is NOT shipped inside plugins/ and
 * must not be imported by the plugin pm-mcp-server.mjs launchers.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/**
 * Start an MCP server child process speaking JSON-RPC over stdio and return a
 * harness with request/callTool helpers plus a dispose() for cleanup.
 *
 * @param {object} options
 * @param {string} options.serverPath - path to the launcher / server entrypoint to spawn
 * @param {string} options.author - PM_AUTHOR value for the sandbox
 * @param {string} options.tmpPrefix - mkdtemp prefix for the sandbox root
 * @param {number} [options.requestTimeoutMs] - per-request timeout
 * @returns {Promise<{tmpRoot: string, request: Function, callTool: Function, getStderr: Function, dispose: Function}>}
 */
export async function startPluginMcpSmoke({
  serverPath,
  author,
  tmpPrefix,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), tmpPrefix));

  const child = spawn(process.execPath, [serverPath], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      PM_AUTHOR: author,
      PM_GLOBAL_PATH: path.join(tmpRoot, ".pm-global"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      stderr += `[mcp-smoke] ignored non-JSON stdout: ${line}\n`;
      return;
    }
    if (!message || typeof message !== "object" || !("id" in message)) {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message));
    } else {
      waiter.resolve(message.result);
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async function callTool(name, args = {}) {
    const response = await request("tools/call", { name, arguments: args });
    if (response.isError) {
      throw new Error(`${name} returned isError: ${response.content?.[0]?.text ?? "unknown"}`);
    }
    return response.structuredContent?.result ?? JSON.parse(response.content[0].text);
  }

  function getStderr() {
    return stderr;
  }

  async function dispose() {
    child.stdin.end();
    child.kill();
    await rm(tmpRoot, { recursive: true, force: true });
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }

  return { tmpRoot, request, callTool, getStderr, dispose };
}
