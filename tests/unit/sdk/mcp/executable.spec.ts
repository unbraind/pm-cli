import { describe, expect, it } from "vitest";
import { resolvePmMcpExecutableInvocation } from "../../../../src/sdk/mcp/executable.js";

describe("MCP executable startup decisions", () => {
  it.each(["stdio", "http"] as const)("serves %s only without probe arguments", (transport) => {
    expect(resolvePmMcpExecutableInvocation([], transport, "1.2.3")).toEqual({ kind: "serve" });
    const result = resolvePmMcpExecutableInvocation(["--unsupported"], transport, "1.2.3");
    expect(result).toMatchObject({ kind: "exit", exitCode: 64, stdout: "" });
    expect(result.kind === "exit" && result.stderr).toContain("--help");
  });

  it.each(["stdio", "http"] as const)("renders %s help from protocol contracts and the supplied version", (transport) => {
    const result = resolvePmMcpExecutableInvocation(["--version", "-h"], transport, "1.2.3");
    expect(result).toMatchObject({ kind: "exit", exitCode: 0, stderr: "" });
    expect(result.kind === "exit" && result.stdout).toContain("@unbrained/pm-cli@1.2.3");
    expect(result.kind === "exit" && result.stdout).toContain(transport === "http" ? "PM_MCP_HTTP_PORT" : "2025-11-25");
  });

  it.each(["--version", "-V"])("prints the exact supplied version for %s", (flag) => {
    expect(resolvePmMcpExecutableInvocation([flag], "stdio", "1.2.3")).toEqual({ kind: "exit", exitCode: 0, stdout: "1.2.3\n", stderr: "" });
  });

  it("accepts the long help alias and refuses an unknown argument even beside help", () => {
    expect(resolvePmMcpExecutableInvocation(["--help"], "stdio", "1.2.3")).toMatchObject({ kind: "exit", exitCode: 0 });
    expect(resolvePmMcpExecutableInvocation(["--help", "--host"], "http", "1.2.3")).toMatchObject({ kind: "exit", exitCode: 64, stdout: "" });
  });
});
