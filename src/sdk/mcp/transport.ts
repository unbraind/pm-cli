/**
 * @module sdk/mcp/transport
 *
 * Implements MCP 2026-07-28 Streamable HTTP header encoding, schema-derived
 * custom header extraction, and body/header parity validation.
 */
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
  isMcpRecord,
  resolveMcpRequestContext,
} from "./protocol.js";

/** Case-insensitive HTTP header input accepted by public transport helpers. */
export type PmMcpHttpHeaders = Record<
  string,
  string | readonly string[] | undefined
>;

/** One statically reachable `x-mcp-header` annotation. */
export interface PmMcpHeaderAnnotation {
  /** Suffix used to construct `Mcp-Param-{name}`. */
  name: string;
  /** Exact property path in tool-call arguments. */
  path: string[];
  /** Primitive schema type permitted by the specification. */
  type: "boolean" | "integer" | "string";
}

const BASE64_SENTINEL_PATTERN = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u;
const HEADER_NAME_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const PLAIN_HEADER_VALUE_PATTERN = /^[\t\x20-\x7E]*$/u;
const REQUIRED_NAME_METHODS = new Set([
  "prompts/get",
  "resources/read",
  "tools/call",
]);

function normalizedHeaders(headers: PmMcpHttpHeaders): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const entry = typeof value === "string" ? value : value.join(", ");
    normalized.set(name.toLowerCase(), entry);
  }
  return normalized;
}

function failHeader(message: string, header: string): never {
  throw new PmMcpProtocolError(message, PM_MCP_ERROR_CODES.headerMismatch, {
    header,
  });
}

/** Encode a name or primitive parameter into the protocol's safe header form. */
export function encodeMcpHttpHeaderValue(
  value: string | number | boolean,
): string {
  const serialized =
    typeof value === "boolean" ? String(value).toLowerCase() : String(value);
  if (
    serialized.length > 0 &&
    serialized.trim() === serialized &&
    PLAIN_HEADER_VALUE_PATTERN.test(serialized) &&
    !BASE64_SENTINEL_PATTERN.test(serialized)
  ) {
    return serialized;
  }
  return `=?base64?${Buffer.from(serialized, "utf8").toString("base64")}?=`;
}

/** Decode and validate a mirrored MCP header value. */
export function decodeMcpHttpHeaderValue(
  value: string,
  header: string,
): string {
  const sentinel = BASE64_SENTINEL_PATTERN.exec(value);
  if (sentinel) {
    const encoded = sentinel[1] as string;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded || decoded.length === 0) {
      return failHeader("Malformed MCP Base64 header value", header);
    }
    return decoded.toString("utf8");
  }
  if (
    value.length === 0 ||
    value.trim() !== value ||
    !PLAIN_HEADER_VALUE_PATTERN.test(value)
  ) {
    return failHeader("Malformed MCP header value", header);
  }
  return value;
}

function containsHeaderAnnotation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsHeaderAnnotation);
  if (!isMcpRecord(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, "x-mcp-header") ||
    Object.values(value).some(containsHeaderAnnotation)
  );
}

/** Validate and normalize one schema-derived custom-header annotation. */
function parseMcpHeaderAnnotation(
  propertySchema: Record<string, unknown>,
  propertyPath: string[],
  names: Set<string>,
): PmMcpHeaderAnnotation | undefined {
  const annotation = propertySchema["x-mcp-header"];
  if (annotation === undefined) return undefined;
  const type = propertySchema.type;
  if (
    typeof annotation !== "string" ||
    !HEADER_NAME_TOKEN_PATTERN.test(annotation) ||
    !["boolean", "integer", "string"].includes(String(type)) ||
    names.has(annotation.toLowerCase())
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP x-mcp-header annotation",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: propertyPath.join("."), annotation },
    );
  }
  names.add(annotation.toLowerCase());
  return {
    name: annotation,
    path: propertyPath,
    type: type as PmMcpHeaderAnnotation["type"],
  };
}

/** Parse valid statically reachable custom-header annotations from a tool schema. */
export function collectMcpHeaderAnnotations(
  schema: unknown,
): PmMcpHeaderAnnotation[] {
  if (!isMcpRecord(schema)) {
    throw new PmMcpProtocolError(
      "Invalid MCP tool schema",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "inputSchema", expected: "object" },
    );
  }
  const annotations: PmMcpHeaderAnnotation[] = [];
  const names = new Set<string>();
  const visitProperties = (node: Record<string, unknown>, path: string[]) => {
    const properties = node.properties;
    if (properties === undefined) return;
    if (!isMcpRecord(properties)) {
      throw new PmMcpProtocolError(
        "Invalid MCP tool schema properties",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: "inputSchema.properties" },
      );
    }
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (!isMcpRecord(propertySchema)) continue;
      const propertyPath = [...path, property];
      const annotation = parseMcpHeaderAnnotation(
        propertySchema,
        propertyPath,
        names,
      );
      if (annotation) annotations.push(annotation);
      for (const [keyword, nested] of Object.entries(propertySchema)) {
        if (
          keyword !== "properties" &&
          keyword !== "x-mcp-header" &&
          containsHeaderAnnotation(nested)
        ) {
          throw new PmMcpProtocolError(
            "MCP x-mcp-header is not statically reachable",
            PM_MCP_ERROR_CODES.invalidParams,
            { field: propertyPath.join("."), keyword },
          );
        }
      }
      visitProperties(propertySchema, propertyPath);
    }
  };
  for (const [keyword, nested] of Object.entries(schema)) {
    if (keyword !== "properties" && containsHeaderAnnotation(nested)) {
      throw new PmMcpProtocolError(
        "MCP x-mcp-header is not statically reachable",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: "inputSchema", keyword },
      );
    }
  }
  visitProperties(schema, []);
  return annotations;
}

function valueAtPath(
  value: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!isMcpRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function mirroredName(
  method: unknown,
  params: Record<string, unknown>,
): string | undefined {
  const value = method === "resources/read" ? params.uri : params.name;
  return typeof value === "string" ? value : undefined;
}

function buildMcpCustomRequestHeaders(
  params: Record<string, unknown>,
  toolSchema: unknown,
): Record<string, string> {
  const argumentsValue = isMcpRecord(params.arguments) ? params.arguments : {};
  const headers: Record<string, string> = {};
  for (const annotation of collectMcpHeaderAnnotations(toolSchema)) {
    const value = valueAtPath(argumentsValue, annotation.path);
    if (value === undefined || value === null) continue;
    const valid =
      (annotation.type === "integer" &&
        typeof value === "number" &&
        Number.isSafeInteger(value)) ||
      (annotation.type === "boolean" && typeof value === "boolean") ||
      (annotation.type === "string" && typeof value === "string");
    if (!valid) {
      throw new PmMcpProtocolError(
        "Invalid MCP custom header argument",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: annotation.path.join("."), expected: annotation.type },
      );
    }
    headers[`Mcp-Param-${annotation.name}`] = encodeMcpHttpHeaderValue(value);
  }
  return headers;
}

/** Build required Streamable HTTP headers for one modern client request. */
export function buildMcpHttpRequestHeaders(input: {
  request: Record<string, unknown>;
  toolSchema?: unknown;
}): Record<string, string> {
  const params = isMcpRecord(input.request.params)
    ? input.request.params
    : undefined;
  const context = resolveMcpRequestContext(params);
  const method = input.request.method;
  if (typeof method !== "string" || method.length === 0) {
    return failHeader("Missing MCP request method", "Mcp-Method");
  }
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": context.protocolVersion,
    "Mcp-Method": method,
  };
  const name = mirroredName(method, params as Record<string, unknown>);
  if (REQUIRED_NAME_METHODS.has(method)) {
    if (name === undefined)
      return failHeader("Missing MCP request name", "Mcp-Name");
    headers["Mcp-Name"] = encodeMcpHttpHeaderValue(name);
  }
  if (method === "tools/call" && input.toolSchema !== undefined) {
    Object.assign(
      headers,
      buildMcpCustomRequestHeaders(
        params as Record<string, unknown>,
        input.toolSchema,
      ),
    );
  }
  return headers;
}

function validateMcpRequiredRequestHeaders(
  headers: Map<string, string>,
  request: Record<string, unknown>,
): void {
  const method = request.method;
  if (typeof method !== "string" || method.length === 0) {
    failHeader("Missing MCP request method", "Mcp-Method");
  }
  const params = isMcpRecord(request.params) ? request.params : undefined;
  const expectedProtocol = resolveMcpRequestContext(params).protocolVersion;
  if (headers.get("mcp-protocol-version") !== expectedProtocol) {
    failHeader(
      "MCP protocol header does not match request metadata",
      "MCP-Protocol-Version",
    );
  }
  if (headers.get("mcp-method") !== method) {
    failHeader("MCP method header does not match request body", "Mcp-Method");
  }
  if (REQUIRED_NAME_METHODS.has(method)) {
    const headerName = headers.get("mcp-name");
    const name = mirroredName(method, params as Record<string, unknown>);
    if (
      headerName === undefined ||
      name === undefined ||
      decodeMcpHttpHeaderValue(headerName, "Mcp-Name") !== name
    ) {
      failHeader("MCP name header does not match request body", "Mcp-Name");
    }
  }
  if (headers.has("last-event-id")) {
    // The preceding match is an mcp-deprecation-negative-control: no resume/redelivery.
    failHeader("MCP SSE resumability is not supported", "Last-Event-ID");
  }
}

function customHeaderMatches(
  annotation: PmMcpHeaderAnnotation,
  value: unknown,
  decoded: string,
): boolean {
  if (annotation.type === "integer") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      Number(decoded) === value
    );
  }
  if (annotation.type === "boolean") {
    return typeof value === "boolean" && decoded === String(value);
  }
  return typeof value === "string" && decoded === value;
}

function validateMcpCustomRequestHeaders(input: {
  headers: Map<string, string>;
  params: Record<string, unknown>;
  toolSchema: unknown;
}): void {
  const argumentsValue = isMcpRecord(input.params.arguments)
    ? input.params.arguments
    : {};
  for (const annotation of collectMcpHeaderAnnotations(input.toolSchema)) {
    const value = valueAtPath(argumentsValue, annotation.path);
    const header = `Mcp-Param-${annotation.name}`;
    const mirrored = input.headers.get(header.toLowerCase());
    if (value === undefined || value === null) {
      if (mirrored !== undefined)
        failHeader("Unexpected MCP parameter header", header);
      continue;
    }
    if (mirrored === undefined)
      failHeader("Missing MCP parameter header", header);
    if (
      !customHeaderMatches(
        annotation,
        value,
        decodeMcpHttpHeaderValue(mirrored, header),
      )
    ) {
      failHeader("MCP parameter header does not match request body", header);
    }
  }
}

/** Validate required Streamable HTTP headers against the JSON-RPC body. */
export function validateMcpHttpRequestHeaders(input: {
  headers: PmMcpHttpHeaders;
  request: Record<string, unknown>;
  toolSchema?: unknown;
}): void {
  const headers = normalizedHeaders(input.headers);
  const method =
    typeof input.request.method === "string" ? input.request.method : "";
  validateMcpRequiredRequestHeaders(headers, input.request);
  if (method !== "tools/call" || input.toolSchema === undefined) return;
  validateMcpCustomRequestHeaders({
    headers,
    params: input.request.params as Record<string, unknown>,
    toolSchema: input.toolSchema,
  });
}

/** Required protocol version exposed for clients constructing headers manually. */
export const PM_MCP_HTTP_PROTOCOL_VERSION = PM_MCP_PROTOCOL_VERSION;
