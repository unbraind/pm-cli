/**
 * @module mcp/legacy-adapter
 *
 * Isolates the bounded MCP 2025-06-18 stdio compatibility surface from the
 * canonical stateless dispatcher. No modern transport imports policy from it.
 */
import { PmCliError, type AgentClientInfo } from "../sdk/runtime-primitives.js";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_LEGACY_PROTOCOL_VERSIONS,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
  type PmMcpImplementation,
  type PmMcpServerCapabilities,
} from "../sdk/mcp/protocol.js";

/** Minimal request shape consumed by the compatibility adapter. */
export interface LegacyMcpRequest {
  /** Legacy method name. */
  method?: string;
  /** Legacy method parameters. */
  params?: Record<string, unknown>;
}

/** Host callbacks keep this adapter separate from canonical SDK policy. */
export interface LegacyMcpAdapterOptions {
  /** Immutable server identity. */
  serverInfo: PmMcpImplementation;
  /** Compatibility-era capabilities. */
  capabilities: PmMcpServerCapabilities;
  /** Model-facing usage instructions. */
  instructions: string;
  /** Parse bounded historical client identity. */
  parseClientInfo: (value: unknown) => AgentClientInfo | undefined;
  /** Resolve legacy tool definitions. */
  listTools: (
    params: Record<string, unknown> | undefined,
  ) => Promise<Record<string, unknown>>;
  /** Execute one legacy tool call. */
  callTool: (
    params: Record<string, unknown> | undefined,
    clientInfo: AgentClientInfo | undefined,
  ) => Promise<Record<string, unknown>>;
  /** List legacy resources. */
  listResources: () => Record<string, unknown>;
  /** Read one legacy resource. */
  readResource: (
    params: Record<string, unknown> | undefined,
  ) => Promise<Record<string, unknown>>;
  /** List legacy prompts. */
  listPrompts: () => Record<string, unknown>;
  /** Render one legacy prompt. */
  getPrompt: (
    params: Record<string, unknown> | undefined,
  ) => Record<string, unknown>;
}

/** Explicit compatibility adapter with no cross-process or modern-session role. */
export class LegacyMcpAdapter {
  readonly #options: LegacyMcpAdapterOptions;
  #clientInfo: AgentClientInfo | undefined;

  /** Create one process-local legacy stdio adapter. */
  constructor(options: LegacyMcpAdapterOptions) {
    this.#options = options;
  }

  /** Read the bounded identity most recently supplied to legacy initialize. */
  getClientInfo(): AgentClientInfo | undefined {
    return this.#clientInfo ? structuredClone(this.#clientInfo) : undefined;
  }

  /** Validate and answer the historical initialize handshake. */
  initialize(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const requestedVersion = params?.protocolVersion;
    if (
      typeof requestedVersion === "string" &&
      !PM_MCP_LEGACY_PROTOCOL_VERSIONS.includes(
        requestedVersion as (typeof PM_MCP_LEGACY_PROTOCOL_VERSIONS)[number],
      )
    ) {
      throw new PmMcpProtocolError(
        "Unsupported legacy MCP protocol version",
        PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
        {
          supported: [...PM_MCP_LEGACY_PROTOCOL_VERSIONS],
          requested: requestedVersion,
          modern: PM_MCP_PROTOCOL_VERSION,
        },
      );
    }
    this.#clientInfo = this.#options.parseClientInfo(params?.clientInfo);
    return {
      protocolVersion: PM_MCP_LEGACY_PROTOCOL_VERSIONS[0],
      capabilities: structuredClone(this.#options.capabilities),
      serverInfo: { ...this.#options.serverInfo },
      instructions: this.#options.instructions,
    };
  }

  /** Dispatch one unversioned request through the finite legacy method set. */
  async dispatch(request: LegacyMcpRequest): Promise<Record<string, unknown>> {
    if (request.method === "ping") return {};
    if (request.method === "tools/list") return this.#options.listTools(request.params);
    if (request.method === "tools/call") {
      return this.#options.callTool(request.params, this.#clientInfo);
    }
    if (request.method === "resources/list") return this.#options.listResources();
    if (request.method === "resources/read") {
      return this.#options.readResource(request.params);
    }
    if (request.method === "prompts/list") return this.#options.listPrompts();
    if (request.method === "prompts/get") return this.#options.getPrompt(request.params);
    throw new PmCliError(
      `Unsupported MCP method: ${request.method ?? "(missing)"}`,
      64,
    );
  }
}
