/**
 * @module sdk/mcp/protocol
 *
 * Defines transport-neutral MCP 2026-07-28 negotiation, request metadata,
 * discovery, result-envelope, and bounded legacy-compatibility contracts.
 */

/** Canonical stateless MCP revision implemented by pm. */
export const PM_MCP_PROTOCOL_VERSION = "2026-07-28" as const;

/**
 * Legacy initialize-era revisions accepted only by the bounded stdio adapter.
 *
 * The canonical revision defines legacy as every version that establishes a
 * session with the handshake method, which is `2025-11-25` and earlier, so this
 * set tracks that boundary rather than a single historical revision.
 * Ordered newest first: element zero is the revision offered to a client that
 * omits `protocolVersion`.
 */
export const PM_MCP_LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
] as const;

/** Modern per-request protocol versions accepted by the stateless core. */
export const PM_MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  PM_MCP_PROTOCOL_VERSION,
] as const;

/** Allocated MCP 2026-07-28 protocol error codes. */
export const PM_MCP_ERROR_CODES = {
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
  invalidParams: -32602,
} as const;

/** Namespaced metadata keys owned by the MCP specification. */
export const PM_MCP_META_KEYS = {
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

/** MCP implementation identity carried in request and result metadata. */
export interface PmMcpImplementation {
  /** Stable implementation name. */
  name: string;
  /** Implementation version. */
  version: string;
  /** Optional human-readable implementation description. */
  description?: string;
  /** Optional implementation website. */
  websiteUrl?: string;
}

/** Open MCP client capability map declared independently on every request. */
export type PmMcpClientCapabilities = Record<string, unknown>;

/** Server capabilities advertised by pm discovery. */
export interface PmMcpServerCapabilities {
  /** Prompt surface and change-notification support. */
  prompts?: { listChanged?: boolean };
  /** Resource surface and change-notification support. */
  resources?: { listChanged?: boolean; subscribe?: boolean };
  /** Tool surface and change-notification support. */
  tools?: { listChanged?: boolean };
  /** Negotiated optional extension settings keyed by extension identifier. */
  extensions?: Record<string, Record<string, unknown>>;
  /** Additional capability declarations retained for forward compatibility. */
  [key: string]: unknown;
}

/** Validated request-local metadata for one modern MCP operation. */
export interface PmMcpRequestContext {
  /** Exact modern protocol revision used by this request. */
  protocolVersion: (typeof PM_MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];
  /** Capabilities declared for this request only. */
  clientCapabilities: PmMcpClientCapabilities;
  /** Optional bounded client identity used only for diagnostics/provenance. */
  clientInfo?: PmMcpImplementation;
}

/** Required fields attached to every modern successful result. */
export interface PmMcpResultEnvelope {
  /** Ordinary successful results are complete. */
  resultType: "complete";
  /** Result-local MCP metadata. */
  _meta: {
    /** Server identity is repeated on every modern result. */
    "io.modelcontextprotocol/serverInfo": PmMcpImplementation;
  };
  /** Additional method-specific result fields. */
  [key: string]: unknown;
}

/** Required server identity metadata attached to every modern result shape. */
export interface PmMcpServerResultMetadata {
  /** Result-local MCP metadata. */
  _meta: {
    /** Server identity is repeated on every modern result. */
    "io.modelcontextprotocol/serverInfo": PmMcpImplementation;
    /** Additional namespaced or application metadata. */
    [key: string]: unknown;
  };
}

/** Modern discovery response contract. */
export interface PmMcpDiscoverResult extends PmMcpResultEnvelope {
  /** Modern stateless revisions accepted through per-request metadata. */
  supportedVersions: string[];
  /** Deterministic server capability declaration. */
  capabilities: PmMcpServerCapabilities;
  /** Cache freshness hint required by the current schema. */
  ttlMs: number;
  /** Discovery is public because it contains no caller-specific data. */
  cacheScope: "public";
  /** Optional model-facing usage guidance. */
  instructions?: string;
}

/** Protocol-era interpretation used at explicit compatibility boundaries. */
export type PmMcpProtocolEra = "modern" | "legacy";

/** Structured MCP protocol error safe for JSON-RPC adapters. */
export class PmMcpProtocolError extends Error {
  /** JSON-RPC/MCP error code. */
  readonly code: number;
  /** Structured recovery or mismatch detail. */
  readonly data: Record<string, unknown>;

  /** Create one typed protocol error. */
  constructor(
    message: string,
    code: number,
    data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PmMcpProtocolError";
    this.code = code;
    this.data = data;
  }
}

/** Return whether an unknown value is a non-array object. */
export function isMcpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse an optional MCP implementation identity without guessing missing fields. */
export function parseMcpImplementation(
  value: unknown,
): PmMcpImplementation | undefined {
  if (value === undefined) return undefined;
  if (!isMcpRecord(value)) {
    throw new PmMcpProtocolError(
      "Invalid MCP clientInfo metadata",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: PM_MCP_META_KEYS.clientInfo, expected: "object" },
    );
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (name.length === 0 || version.length === 0) {
    throw new PmMcpProtocolError(
      "Invalid MCP clientInfo metadata",
      PM_MCP_ERROR_CODES.invalidParams,
      {
        field: PM_MCP_META_KEYS.clientInfo,
        required: ["name", "version"],
      },
    );
  }
  const parsed: PmMcpImplementation = {
    name: name.slice(0, 128),
    version: version.slice(0, 128),
  };
  if (typeof value.description === "string" && value.description.trim()) {
    parsed.description = value.description.trim().slice(0, 1024);
  }
  if (typeof value.websiteUrl === "string" && value.websiteUrl.trim()) {
    parsed.websiteUrl = value.websiteUrl.trim().slice(0, 2048);
  }
  return parsed;
}

/** Validate the stateless metadata required on every modern MCP request. */
export function resolveMcpRequestContext(params: unknown): PmMcpRequestContext {
  const meta = isMcpRecord(params) ? params._meta : undefined;
  if (!isMcpRecord(meta)) {
    throw new PmMcpProtocolError(
      "Missing required MCP request metadata",
      PM_MCP_ERROR_CODES.invalidParams,
      {
        required: [
          PM_MCP_META_KEYS.protocolVersion,
          PM_MCP_META_KEYS.clientCapabilities,
        ],
      },
    );
  }
  const requested = meta[PM_MCP_META_KEYS.protocolVersion];
  if (
    typeof requested !== "string" ||
    !PM_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(
      requested as (typeof PM_MCP_SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
  ) {
    throw new PmMcpProtocolError(
      "Unsupported protocol version",
      PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
      {
        supported: [...PM_MCP_SUPPORTED_PROTOCOL_VERSIONS],
        requested: typeof requested === "string" ? requested : null,
      },
    );
  }
  const clientCapabilities = meta[PM_MCP_META_KEYS.clientCapabilities];
  if (!isMcpRecord(clientCapabilities)) {
    throw new PmMcpProtocolError(
      "Invalid MCP client capabilities metadata",
      PM_MCP_ERROR_CODES.invalidParams,
      {
        field: PM_MCP_META_KEYS.clientCapabilities,
        expected: "object",
      },
    );
  }
  const clientInfo = parseMcpImplementation(meta[PM_MCP_META_KEYS.clientInfo]);
  return {
    protocolVersion: PM_MCP_PROTOCOL_VERSION,
    clientCapabilities,
    ...(clientInfo ? { clientInfo } : {}),
  };
}

/** Validate the HTTP protocol-version header against request-local metadata. */
export function assertMcpProtocolHeader(
  requestContext: PmMcpRequestContext,
  headerValue: string | undefined,
): void {
  if (headerValue !== requestContext.protocolVersion) {
    throw new PmMcpProtocolError(
      "MCP protocol header does not match request metadata",
      PM_MCP_ERROR_CODES.headerMismatch,
      {
        header: headerValue ?? null,
        metadata: requestContext.protocolVersion,
      },
    );
  }
}

/** Require named client capabilities without consulting prior requests. */
export function assertMcpClientCapabilities(
  requestContext: PmMcpRequestContext,
  requiredCapabilities: readonly string[],
): void {
  const missing = requiredCapabilities.filter(
    (capability) =>
      !Object.prototype.hasOwnProperty.call(
        requestContext.clientCapabilities,
        capability,
      ),
  );
  if (missing.length > 0) {
    throw new PmMcpProtocolError(
      "Missing required client capability",
      PM_MCP_ERROR_CODES.missingRequiredClientCapability,
      {
        requiredCapabilities: Object.fromEntries(
          missing.map((capability) => [capability, {}]),
        ),
      },
    );
  }
}

/** Return whether this request independently negotiated one named extension. */
export function hasMcpClientExtension(
  requestContext: PmMcpRequestContext,
  extension: string,
): boolean {
  const extensions = requestContext.clientCapabilities.extensions;
  return isMcpRecord(extensions) && isMcpRecord(extensions[extension]);
}

/** Attach required server identity while preserving a non-complete result discriminator. */
export function attachMcpServerInfo<Payload extends Record<string, unknown>>(
  payload: Payload,
  serverInfo: PmMcpImplementation,
): Payload & PmMcpServerResultMetadata {
  const payloadMeta = isMcpRecord(payload._meta) ? payload._meta : {};
  return {
    ...payload,
    _meta: {
      ...payloadMeta,
      [PM_MCP_META_KEYS.serverInfo]: { ...serverInfo },
    },
  };
}

/** Attach required modern result fields without mutating the caller payload. */
export function buildMcpCompleteResult<Payload extends Record<string, unknown>>(
  payload: Payload,
  serverInfo: PmMcpImplementation,
): Payload & PmMcpResultEnvelope {
  return attachMcpServerInfo(
    { ...payload, resultType: "complete" as const },
    serverInfo,
  );
}

/** Build deterministic current-revision server discovery. */
export function buildMcpDiscoverResult(input: {
  serverInfo: PmMcpImplementation;
  capabilities: PmMcpServerCapabilities;
  instructions?: string;
  ttlMs?: number;
}): PmMcpDiscoverResult {
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new PmMcpProtocolError(
      "Invalid MCP discovery cache TTL",
      PM_MCP_ERROR_CODES.invalidParams,
      { ttlMs },
    );
  }
  return buildMcpCompleteResult(
    {
      supportedVersions: [...PM_MCP_SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: structuredClone(input.capabilities),
      ttlMs,
      cacheScope: "public" as const,
      ...(input.instructions ? { instructions: input.instructions } : {}),
    },
    input.serverInfo,
  );
}

/**
 * Interpret resultType only at an explicit protocol-era boundary. Legacy
 * results may omit it; modern results fail closed when it is absent.
 */
export function interpretMcpResultType(
  result: unknown,
  era: PmMcpProtocolEra,
): string {
  if (isMcpRecord(result) && typeof result.resultType === "string") {
    return result.resultType;
  }
  if (era === "legacy") return "complete";
  throw new PmMcpProtocolError(
    "Modern MCP result is missing resultType",
    PM_MCP_ERROR_CODES.invalidParams,
    { required: "resultType" },
  );
}
