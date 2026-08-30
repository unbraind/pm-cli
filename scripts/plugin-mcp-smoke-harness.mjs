/**
 * Shared smoke harness for the plugin MCP launchers.
 *
 * Both scripts/smoke-claude-plugin.mjs and scripts/smoke-codex-plugin-mcp.mjs
 * spawn a stdio MCP server, speak JSON-RPC over stdin/stdout, list tools, and
 * drive an identical full-profile pm_run(init) → create → claim → update →
 * comments → files → docs → test → get → context workflow in a sandbox. This
 * module owns the spawn / JSON-RPC / readiness / cleanup plumbing they shared
 * verbatim.
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
const MCP_PROTOCOL_VERSION = "2026-07-28";

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
/**
 * Drive a real `initialize` handshake against a launcher once for EVERY protocol
 * revision the published SDK surface declares, plus a negative control.
 *
 * The revision list is read from the built SDK rather than restated here, so the
 * matrix can never iterate a shorter hand-maintained list than the one the
 * transport actually accepts. Each accepted revision must be echoed back
 * verbatim, because a legacy client has no fall-forward mechanism and treats the
 * answered version as the negotiated one. The negative control proves the widened
 * set still refuses an unknown revision and names every supported revision in the
 * refusal, since that error text is the only diagnostic such a client can surface.
 *
 * @param {object} options
 * @param {string} options.serverPath - launcher entrypoint to spawn per revision
 * @param {string} options.author - PM_AUTHOR value for the sandbox
 * @param {string} options.tmpPrefix - mkdtemp prefix for the sandbox root
 * @param {readonly string[]} [options.legacyProtocolVersions] - declared initialize-era revisions; defaults to the built SDK's own list
 * @param {string} [options.modernProtocolVersion] - declared canonical stateless revision; defaults to the built SDK's own value
 * @returns {Promise<{negotiated: string[], refused: string}>}
 */
export async function assertProtocolHandshakeMatrix({
  serverPath,
  author,
  tmpPrefix,
  legacyProtocolVersions,
  modernProtocolVersion,
}) {
  // Read the declared revisions from the built SDK lazily: a static import would
  // pull the whole bundle into every consumer of this module's spawn plumbing.
  if (legacyProtocolVersions === undefined || modernProtocolVersion === undefined) {
    const sdk = await import("../dist/cli-bundle/sdk.js");
    legacyProtocolVersions ??= sdk.PM_MCP_LEGACY_PROTOCOL_VERSIONS;
    modernProtocolVersion ??= sdk.PM_MCP_PROTOCOL_VERSION;
  }
  if (!Array.isArray(legacyProtocolVersions) || legacyProtocolVersions.length === 0) {
    throw new Error(
      "handshake matrix requires the declared legacy revision list from the built SDK",
    );
  }
  const negotiated = [];
  for (const version of legacyProtocolVersions) {
    const smoke = await startPluginMcpSmoke({ serverPath, author, tmpPrefix });
    try {
      const result = await smoke.request("initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: author, version: "1.0.0" },
      });
      if (result?.protocolVersion !== version) {
        throw new Error(
          `initialize(${version}) negotiated "${result?.protocolVersion}"; a legacy client cannot fall forward from a version it did not request`,
        );
      }
      if (!result?.serverInfo?.name) {
        throw new Error(`initialize(${version}) returned no serverInfo.name`);
      }
      negotiated.push(version);
    } finally {
      await smoke.dispose();
    }
  }

  const unsupported = "1900-01-01";
  const control = await startPluginMcpSmoke({ serverPath, author, tmpPrefix });
  let refused = "";
  try {
    await control.request("initialize", {
      protocolVersion: unsupported,
      capabilities: {},
      clientInfo: { name: author, version: "1.0.0" },
    });
    throw new Error(
      `negative control failed: initialize(${unsupported}) was accepted, so the accept list enforces nothing`,
    );
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
    if (!refused.toLowerCase().includes("protocol version")) {
      throw error;
    }
  } finally {
    await control.dispose();
  }

  const probe = await startPluginMcpSmoke({ serverPath, author, tmpPrefix });
  try {
    const discovered = await probe.request("server/discover", {});
    const supported = discovered?.supportedVersions ?? [];
    if (!supported.includes(modernProtocolVersion)) {
      throw new Error(
        `server/discover advertised ${JSON.stringify(supported)} which omits the declared canonical revision ${modernProtocolVersion}`,
      );
    }
  } finally {
    await probe.dispose();
  }

  return { negotiated, refused };
}

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
      PM_MCP_PROFILE: "full",
      PM_PATH: path.join(tmpRoot, ".agents", "pm"),
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
    const requestParams =
      method === "initialize"
        ? params
        : {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: author,
                version: "1.0.0",
              },
              ...params._meta,
            },
          };
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params: requestParams })}\n`,
    );
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
