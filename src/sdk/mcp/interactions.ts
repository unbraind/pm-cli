/**
 * @module sdk/mcp/interactions
 *
 * Implements bounded MCP 2026-07-28 multi round-trip request, cache, and JSON
 * Schema contracts without coupling protocol policy to a transport adapter.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_META_KEYS,
  PmMcpProtocolError,
  isMcpRecord,
  type PmMcpImplementation,
  type PmMcpRequestContext,
} from "./protocol.js";

/** Methods permitted inside a 2026-07-28 MRTR input request map. */
export const PM_MCP_INPUT_REQUEST_METHODS = [
  "elicitation/create",
  "roots/list",
  "sampling/createMessage",
] as const;

/** One typed request that a host must fulfill before retrying an operation. */
export interface PmMcpInputRequest {
  /** Current MCP server-to-client request method. */
  method: (typeof PM_MCP_INPUT_REQUEST_METHODS)[number];
  /** Method-specific parameters retained as an open protocol object. */
  params: Record<string, unknown>;
}

/** Server-assigned MRTR input identifiers mapped to bounded requests. */
export type PmMcpInputRequests = Record<string, PmMcpInputRequest>;

/** Host responses keyed by the identifiers in an earlier input request map. */
export type PmMcpInputResponses = Record<string, Record<string, unknown>>;

/** Modern interim result returned when an operation needs more host input. */
export interface PmMcpInputRequiredResult {
  /** MRTR discriminator required by the current protocol. */
  resultType: "input_required";
  /** Optional bounded requests the host must fulfill. */
  inputRequests?: PmMcpInputRequests;
  /** Optional integrity-protected state echoed unchanged on retry. */
  requestState?: string;
  /** Result-local MCP metadata. */
  _meta: {
    /** Server identity repeated on every modern result. */
    "io.modelcontextprotocol/serverInfo": PmMcpImplementation;
  };
  /** Additional forward-compatible result fields. */
  [key: string]: unknown;
}

/**
 * Transport-neutral control signal used by SDK handlers to request an MRTR
 * response without constructing or serializing JSON-RPC in domain code.
 */
export class PmMcpInputRequiredError extends Error {
  /** Server-authored input requests validated by the adapter. */
  readonly inputRequests?: unknown;
  /** Optional opaque continuation state echoed on retry. */
  readonly requestState?: string;

  /** Create an input-required control signal. */
  constructor(input: { inputRequests?: unknown; requestState?: string }) {
    super("MCP operation requires additional input");
    this.name = "PmMcpInputRequiredError";
    this.inputRequests = input.inputRequests;
    this.requestState = input.requestState;
  }
}

/** Cache fields required on current list and read results. */
export interface PmMcpCachePolicy {
  /** Milliseconds for which a client may consider the response fresh. */
  ttlMs: number;
  /** Whether shared intermediaries may reuse the response. */
  cacheScope: "private" | "public";
  /** Additional forward-compatible cache fields. */
  [key: string]: unknown;
}

/** Work bounds applied while validating an advertised JSON Schema. */
export interface PmMcpJsonSchemaBounds {
  /** Maximum serialized schema bytes. */
  maxBytes?: number;
  /** Maximum nested object or array depth. */
  maxDepth?: number;
  /** Maximum visited object, array, and scalar nodes. */
  maxNodes?: number;
}

/** State sealed into an opaque MRTR requestState value. */
export interface PmMcpRequestStatePayload {
  /** Absolute expiration timestamp in milliseconds. */
  expiresAt: number;
  /** Original JSON-RPC method this state may resume. */
  method: string;
  /** Digest of the original request's salient parameters. */
  parameterDigest: string;
  /** Principal binding chosen by the host or authorization layer. */
  principal: string;
  /** Application-owned continuation data. */
  state: unknown;
}

const INPUT_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u;
const MAX_INPUT_REQUESTS = 32;
const MAX_INPUT_PAYLOAD_BYTES = 64 * 1024;
const MAX_REQUEST_STATE_BYTES = 16 * 1024;
const DEFAULT_SCHEMA_BOUNDS = {
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxNodes: 4096,
} as const;

function inputCapability(method: PmMcpInputRequest["method"]): string {
  if (method === "elicitation/create") return "elicitation";
  if (method === "sampling/createMessage") return "sampling";
  return "roots";
}

function assertBoundedJson(
  value: unknown,
  maximumBytes: number,
  field: string,
): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PmMcpProtocolError(
      `Invalid ${field}: value is not JSON serializable`,
      PM_MCP_ERROR_CODES.invalidParams,
      { field },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new PmMcpProtocolError(
      `Invalid ${field}: payload exceeds the protocol bound`,
      PM_MCP_ERROR_CODES.invalidParams,
      { field, maximumBytes },
    );
  }
}

/** Validate and clone a server-authored MRTR request map. */
export function parseMcpInputRequests(
  value: unknown,
  requestContext: PmMcpRequestContext,
): PmMcpInputRequests {
  if (!isMcpRecord(value)) {
    throw new PmMcpProtocolError(
      "Invalid MCP inputRequests",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "inputRequests", expected: "object" },
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_INPUT_REQUESTS) {
    throw new PmMcpProtocolError(
      "Invalid MCP inputRequests count",
      PM_MCP_ERROR_CODES.invalidParams,
      { minimum: 1, maximum: MAX_INPUT_REQUESTS, observed: entries.length },
    );
  }
  const parsed: PmMcpInputRequests = {};
  for (const [key, request] of entries) {
    if (!INPUT_KEY_PATTERN.test(key) || !isMcpRecord(request)) {
      throw new PmMcpProtocolError(
        "Invalid MCP input request entry",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: `inputRequests.${key}` },
      );
    }
    const method = request.method;
    if (
      typeof method !== "string" ||
      !PM_MCP_INPUT_REQUEST_METHODS.includes(
        method as PmMcpInputRequest["method"],
      )
    ) {
      throw new PmMcpProtocolError(
        "Unsupported MCP input request method",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: `inputRequests.${key}.method`, method: method ?? null },
      );
    }
    const capability = inputCapability(method as PmMcpInputRequest["method"]);
    if (
      !Object.prototype.hasOwnProperty.call(
        requestContext.clientCapabilities,
        capability,
      )
    ) {
      throw new PmMcpProtocolError(
        "Missing required client capability",
        PM_MCP_ERROR_CODES.missingRequiredClientCapability,
        { requiredCapabilities: { [capability]: {} } },
      );
    }
    if (!isMcpRecord(request.params)) {
      throw new PmMcpProtocolError(
        "Invalid MCP input request parameters",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: `inputRequests.${key}.params`, expected: "object" },
      );
    }
    parsed[key] = {
      method: method as PmMcpInputRequest["method"],
      params: structuredClone(request.params),
    };
  }
  assertBoundedJson(parsed, MAX_INPUT_PAYLOAD_BYTES, "inputRequests");
  return parsed;
}

/** Validate and clone client-supplied input responses from an MRTR retry. */
export function parseMcpInputResponses(value: unknown): PmMcpInputResponses {
  if (!isMcpRecord(value)) {
    throw new PmMcpProtocolError(
      "Invalid MCP inputResponses",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "inputResponses", expected: "object" },
    );
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_INPUT_REQUESTS) {
    throw new PmMcpProtocolError(
      "Invalid MCP inputResponses count",
      PM_MCP_ERROR_CODES.invalidParams,
      { maximum: MAX_INPUT_REQUESTS, observed: entries.length },
    );
  }
  const parsed: PmMcpInputResponses = {};
  for (const [key, response] of entries) {
    if (!INPUT_KEY_PATTERN.test(key) || !isMcpRecord(response)) {
      throw new PmMcpProtocolError(
        "Invalid MCP input response entry",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: `inputResponses.${key}` },
      );
    }
    parsed[key] = structuredClone(response);
  }
  assertBoundedJson(parsed, MAX_INPUT_PAYLOAD_BYTES, "inputResponses");
  return parsed;
}

/** Build a modern input-required result after validating capability and size bounds. */
export function buildMcpInputRequiredResult(input: {
  requestContext: PmMcpRequestContext;
  serverInfo: PmMcpImplementation;
  inputRequests?: unknown;
  requestState?: string;
}): PmMcpInputRequiredResult {
  const requestState = input.requestState?.trim();
  if (
    requestState &&
    Buffer.byteLength(requestState, "utf8") > MAX_REQUEST_STATE_BYTES
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState: payload exceeds the protocol bound",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState", maximumBytes: MAX_REQUEST_STATE_BYTES },
    );
  }
  const inputRequests =
    input.inputRequests === undefined
      ? undefined
      : parseMcpInputRequests(input.inputRequests, input.requestContext);
  if (inputRequests === undefined && !requestState) {
    throw new PmMcpProtocolError(
      "InputRequiredResult requires inputRequests or requestState",
      PM_MCP_ERROR_CODES.invalidParams,
      { requiredAnyOf: ["inputRequests", "requestState"] },
    );
  }
  return {
    resultType: "input_required",
    ...(inputRequests ? { inputRequests } : {}),
    ...(requestState ? { requestState } : {}),
    _meta: {
      [PM_MCP_META_KEYS.serverInfo]: { ...input.serverInfo },
    },
  };
}

function requestStateSecret(secret: string | Uint8Array): Buffer {
  const bytes = Buffer.from(secret);
  if (bytes.byteLength < 32) {
    throw new PmMcpProtocolError(
      "MCP requestState signing key must contain at least 32 bytes",
      PM_MCP_ERROR_CODES.invalidParams,
      { minimumBytes: 32 },
    );
  }
  return bytes;
}

/** Seal integrity-protected continuation state for an MRTR retry. */
export function sealMcpRequestState(
  payload: PmMcpRequestStatePayload,
  secret: string | Uint8Array,
): string {
  if (
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= 0 ||
    payload.method.trim().length === 0 ||
    payload.parameterDigest.trim().length === 0 ||
    payload.principal.trim().length === 0
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState payload",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  const encoded = Buffer.from(
    JSON.stringify({ version: 1, ...payload }),
    "utf8",
  );
  if (encoded.byteLength > MAX_REQUEST_STATE_BYTES / 2) {
    throw new PmMcpProtocolError(
      "MCP requestState payload exceeds the protocol bound",
      PM_MCP_ERROR_CODES.invalidParams,
      { maximumBytes: MAX_REQUEST_STATE_BYTES / 2 },
    );
  }
  const body = encoded.toString("base64url");
  const signature = createHmac("sha256", requestStateSecret(secret))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function parseMcpRequestStatePayload(
  decoded: unknown,
): PmMcpRequestStatePayload {
  if (!isMcpRecord(decoded) || decoded.version !== 1) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState payload",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState" },
    );
  }
  const { expiresAt, method, parameterDigest, principal, state } = decoded;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState payload",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState" },
    );
  }
  if (
    typeof method !== "string" ||
    typeof parameterDigest !== "string" ||
    typeof principal !== "string"
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState payload",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState" },
    );
  }
  return { expiresAt, method, parameterDigest, principal, state };
}

/** Verify an MRTR requestState value against method, principal, digest, and expiry. */
export function openMcpRequestState(
  value: string,
  secret: string | Uint8Array,
  expected: {
    method: string;
    parameterDigest: string;
    principal: string;
    nowMs?: number;
  },
): PmMcpRequestStatePayload {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState encoding",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState" },
    );
  }
  const observed = Buffer.from(signature, "base64url");
  const calculated = createHmac("sha256", requestStateSecret(secret))
    .update(body)
    .digest();
  if (
    observed.byteLength !== calculated.byteLength ||
    !timingSafeEqual(observed, calculated)
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP requestState signature",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState" },
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  const payload = parseMcpRequestStatePayload(decoded);
  const { expiresAt, method, parameterDigest, principal } = payload;
  if (expiresAt < (expected.nowMs ?? Date.now())) {
    throw new PmMcpProtocolError(
      "Expired MCP requestState",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState", expiredAt: expiresAt },
    );
  }
  if (
    method !== expected.method ||
    parameterDigest !== expected.parameterDigest ||
    principal !== expected.principal
  ) {
    throw new PmMcpProtocolError(
      "MCP requestState binding mismatch",
      PM_MCP_ERROR_CODES.invalidParams,
      { field: "requestState" },
    );
  }
  return payload;
}

/** Compute a stable-sized digest for application-selected salient request data. */
export function digestMcpRequestParameters(value: unknown): string {
  assertBoundedJson(value, MAX_INPUT_PAYLOAD_BYTES, "request parameters");
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Bound single-use MRTR state consumption within one server process. Callers
 * requiring cross-process one-time semantics should persist the resulting hash.
 */
export class PmMcpRequestStateReplayGuard {
  readonly #consumed = new Set<string>();
  readonly #maximumEntries: number;

  /** Create a bounded in-process replay guard. */
  constructor(maximumEntries = 4096) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new PmMcpProtocolError(
        "Invalid MCP replay guard capacity",
        PM_MCP_ERROR_CODES.invalidParams,
        { maximumEntries },
      );
    }
    this.#maximumEntries = maximumEntries;
  }

  /** Consume one opaque requestState value exactly once in this process. */
  consume(value: string): void {
    const digest = createHash("sha256").update(value).digest("hex");
    if (this.#consumed.has(digest)) {
      throw new PmMcpProtocolError(
        "MCP requestState replay detected",
        PM_MCP_ERROR_CODES.invalidParams,
        { field: "requestState" },
      );
    }
    if (this.#consumed.size >= this.#maximumEntries) {
      const oldest = this.#consumed.values().next().value!;
      this.#consumed.delete(oldest);
    }
    this.#consumed.add(digest);
  }
}

/** Validate and clone a required MCP cache policy. */
export function parseMcpCachePolicy(value: PmMcpCachePolicy): PmMcpCachePolicy {
  if (
    !Number.isSafeInteger(value.ttlMs) ||
    value.ttlMs < 0 ||
    (value.cacheScope !== "public" && value.cacheScope !== "private")
  ) {
    throw new PmMcpProtocolError(
      "Invalid MCP cache policy",
      PM_MCP_ERROR_CODES.invalidParams,
      { ttlMs: value.ttlMs, cacheScope: value.cacheScope },
    );
  }
  return { ttlMs: value.ttlMs, cacheScope: value.cacheScope };
}

/** Attach required cache fields without mutating a method-specific payload. */
export function withMcpCachePolicy<Payload extends Record<string, unknown>>(
  payload: Payload,
  policy: PmMcpCachePolicy,
): Payload & PmMcpCachePolicy {
  return { ...payload, ...parseMcpCachePolicy(policy) };
}

function decodeJsonPointerToken(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveLocalJsonSchemaReference(
  root: unknown,
  reference: string,
): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let current = root;
  for (const token of reference
    .slice(2)
    .split("/")
    .map(decodeJsonPointerToken)) {
    if (!isMcpRecord(current) && !Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function resolveMcpJsonSchemaBounds(bounds: PmMcpJsonSchemaBounds): {
  maximumBytes: number;
  maximumDepth: number;
  maximumNodes: number;
} {
  const maximumBytes = bounds.maxBytes ?? DEFAULT_SCHEMA_BOUNDS.maxBytes;
  const maximumDepth = bounds.maxDepth ?? DEFAULT_SCHEMA_BOUNDS.maxDepth;
  const maximumNodes = bounds.maxNodes ?? DEFAULT_SCHEMA_BOUNDS.maxNodes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2) {
    throw new PmMcpProtocolError(
      "Invalid MCP JSON Schema work bounds",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1) {
    throw new PmMcpProtocolError(
      "Invalid MCP JSON Schema work bounds",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1) {
    throw new PmMcpProtocolError(
      "Invalid MCP JSON Schema work bounds",
      PM_MCP_ERROR_CODES.invalidParams,
    );
  }
  return { maximumBytes, maximumDepth, maximumNodes };
}

function enqueueMcpJsonSchemaChildren(
  current: { value: unknown; depth: number },
  pending: Array<{ value: unknown; depth: number }>,
): void {
  const entries = Array.isArray(current.value)
    ? current.value
    : isMcpRecord(current.value)
      ? Object.values(current.value)
      : [];
  for (const entry of entries) {
    pending.push({ value: entry, depth: current.depth + 1 });
  }
}

function assertMcpJsonSchemaReference(root: unknown, value: unknown): void {
  if (!isMcpRecord(value) || typeof value.$ref !== "string") return;
  const reference = value.$ref;
  if (
    reference.startsWith("#") &&
    resolveLocalJsonSchemaReference(root, reference) === undefined
  ) {
    throw new PmMcpProtocolError(
      "MCP JSON Schema contains an unresolved local reference",
      PM_MCP_ERROR_CODES.invalidParams,
      { reference },
    );
  }
}

/**
 * Validate JSON Schema 2020-12 structure under explicit byte, depth, node, and
 * local-reference work bounds while allowing the complete keyword vocabulary.
 */
export function validateMcpJsonSchema(
  schema: unknown,
  bounds: PmMcpJsonSchemaBounds = {},
): unknown {
  const { maximumBytes, maximumDepth, maximumNodes } =
    resolveMcpJsonSchemaBounds(bounds);
  if (typeof schema !== "boolean" && !isMcpRecord(schema)) {
    throw new PmMcpProtocolError(
      "Invalid MCP JSON Schema root",
      PM_MCP_ERROR_CODES.invalidParams,
      { expected: "object or boolean" },
    );
  }
  assertBoundedJson(schema, maximumBytes, "JSON Schema");
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: schema, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > maximumNodes || current.depth > maximumDepth) {
      throw new PmMcpProtocolError(
        "MCP JSON Schema exceeds validation work bounds",
        PM_MCP_ERROR_CODES.invalidParams,
        { maximumDepth, maximumNodes },
      );
    }
    assertMcpJsonSchemaReference(schema, current.value);
    enqueueMcpJsonSchemaChildren(current, pending);
  }
  return structuredClone(schema);
}
