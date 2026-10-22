/**
 * @module sdk/mcp/executable
 *
 * Resolves MCP executable probes without reading configuration or starting a transport.
 */
import {
  PM_MCP_LEGACY_PROTOCOL_VERSIONS,
  PM_MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol.js";

/** Transport selected by an MCP executable or embedded launcher. */
export type PmMcpExecutableTransport = "stdio" | "http";

/** Pure startup decision that a host renders before opening stdin or a listener. */
export type PmMcpExecutableInvocation =
  | { kind: "serve" }
  | { kind: "exit"; exitCode: 0 | 64; stdout: string; stderr: string };

const PROBE_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

/** Compose version-pinned launch guidance from the authoritative protocol revisions. */
function executableHelp(transport: PmMcpExecutableTransport, version: string): string {
  const name = transport === "stdio" ? "pm-mcp" : "pm-mcp-http";
  const lines = [
    `Usage: ${name} [--help | --version]`,
    "",
    transport === "stdio"
      ? "JSON-RPC over stdin/stdout. With no arguments, starts the stdio server."
      : "Streamable HTTP POST /mcp. With no arguments, starts the HTTP server.",
    "",
    "Options:",
    "  -h, --help       Print help and exit before transport startup.",
    "  -V, --version    Print the package version and exit.",
    "",
    "Environment:",
    "  PM_PATH                     Tracker root (otherwise discovered from cwd).",
    "  PM_GLOBAL_PATH              Global settings root.",
    "  PM_MCP_PROFILE              core (default), standard, full, or custom.",
    "  PM_MCP_TOOLS                Comma-separated tool allowlist for custom profile.",
    "  PM_MCP_DISCOVERY_CURSOR_KEY  Shared discovery cursor secret, at least 32 UTF-8 bytes.",
    "  PM_MCP_BAGGAGE_ALLOWLIST     Comma-separated permitted trace baggage keys.",
  ];
  if (transport === "http") lines.push(
    "  PM_MCP_HTTP_HOST             Bind host (default 127.0.0.1).",
    "  PM_MCP_HTTP_PORT             Bind port, 0..65535 (default 3000).",
    "  PM_MCP_HTTP_ALLOWED_ORIGINS  Comma-separated exact browser origins (default none).",
    "  PM_MCP_HTTP_BEARER_TOKEN     Deployment token for the bundled verifier.",
    "  PM_MCP_HTTP_AUTH_ISSUER      Exact HTTPS authorization-server issuer.",
    "  PM_MCP_HTTP_RESOURCE         Canonical resource/audience URI.",
    "  PM_MCP_HTTP_SCOPES           Space-separated scopes (default pm:read pm:write).",
    "",
    "Non-loopback HTTP requires bearer token, issuer, and resource together.",
  );
  lines.push(
    "",
    `MCP protocol: ${PM_MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
    transport === "stdio"
      ? `Legacy initialize compatibility: ${PM_MCP_LEGACY_PROTOCOL_VERSIONS.join(", ")}.`
      : "HTTP requires modern per-request metadata; legacy initialize is stdio-only.",
    "",
    transport === "stdio" ? "Client configuration:" : "Example loopback server:",
    transport === "stdio"
      ? JSON.stringify({ mcpServers: { pm: { command: "npx", args: ["--yes", "--package", `@unbrained/pm-cli@${version}`, "pm-mcp"] } } })
      : `PM_MCP_HTTP_PORT=3000 npx --yes --package @unbrained/pm-cli@${version} pm-mcp-http`,
    ...(transport === "http" ? ["HTTP client configuration:", JSON.stringify({ mcpServers: { pm: { url: "http://127.0.0.1:3000/mcp" } } })] : []),
    "",
    "Configuration: https://github.com/unbraind/pm-cli/blob/main/docs/MCP_REMOTE_TRANSPORT_SECURITY.md",
    "",
  );
  return lines.join("\n");
}

/** Resolve help/version/usage before the host reads environment settings or starts serving. */
export function resolvePmMcpExecutableInvocation(
  argv: readonly string[],
  transport: PmMcpExecutableTransport,
  version: string,
): PmMcpExecutableInvocation {
  if (argv.length === 0) return { kind: "serve" };
  const unknown = argv.find((argument) => !PROBE_FLAGS.has(argument));
  if (unknown !== undefined) {
    const name = transport === "stdio" ? "pm-mcp" : "pm-mcp-http";
    return { kind: "exit", exitCode: 64, stdout: "", stderr: `Unsupported argument ${JSON.stringify(unknown)}. Run ${name} --help.\n` };
  }
  const help = argv.includes("--help") || argv.includes("-h");
  return {
    kind: "exit",
    exitCode: 0,
    stdout: help ? executableHelp(transport, version) : `${version}\n`,
    stderr: "",
  };
}
