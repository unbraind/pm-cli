import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../helpers/temp.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Keep stdin open so a help probe cannot succeed by starting and exhausting stdio. */
function probeExecutable(script: string, argument: string, root: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "dist/mcp", script), argument], {
      cwd: root,
      env: {
        ...process.env,
        PM_PATH: path.join(root, "tracker"),
        PM_GLOBAL_PATH: path.join(root, "global"),
        PM_MCP_HTTP_HOST: "0.0.0.0",
        PM_MCP_HTTP_PORT: "invalid",
        PM_MCP_HTTP_BEARER_TOKEN: "",
        PM_MCP_HTTP_AUTH_ISSUER: "",
        PM_MCP_HTTP_RESOURCE: "",
        PM_MCP_PROFILE: "invalid",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

describe.each([
  ["server.js", "pm-mcp"],
  ["http-server.js", "pm-mcp-http"],
])("%s executable probes", (script, name) => {
  it.each(["--help", "-h"])("prints %s without transport or workspace startup", async (argument) => {
    await withTempDir("pm-mcp-help-", async (root) => {
      const result = await probeExecutable(script, argument, root);
      expect(result).toMatchObject({ code: 0, timedOut: false, stderr: "" });
      expect(result.stdout).toContain(`Usage: ${name}`);
      expect(result.stdout).toContain("PM_PATH");
      expect(result.stdout).toContain("PM_MCP_PROFILE");
      expect(result.stdout).toContain("2026-07-28");
      expect(result.stdout).toContain("npx");
      expect(await readdir(root)).toEqual([]);
    });
  });

  it.each(["--version", "-V"])("prints %s before reading invalid server configuration", async (argument) => {
    await withTempDir("pm-mcp-version-", async (root) => {
      const result = await probeExecutable(script, argument, root);
      expect(result).toMatchObject({ code: 0, timedOut: false, stderr: "" });
      expect(result.stdout).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}\n$/u);
      expect(await readdir(root)).toEqual([]);
    });
  });
});
