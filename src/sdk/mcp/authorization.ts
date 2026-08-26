/**
 * @module sdk/mcp/authorization
 *
 * Defines issuer-bound OAuth resource-server, client-registration, credential,
 * and privacy-bounded trace propagation primitives for remote MCP transports.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import { isMcpRecord } from "./protocol.js";
import type { PmMcpHttpHeaders } from "./transport.js";

/** Authorization failure with an HTTP status and disclosure-safe context. */
export class PmMcpAuthorizationError extends Error {
  /** HTTP status required at the remote MCP boundary. */
  readonly httpStatus: 401 | 403;
  /** Optional RFC 6750 challenge safe to send to an unauthenticated client. */
  readonly challenge?: string;

  /** Create one remote authorization refusal. */
  constructor(message: string, httpStatus: 401 | 403, challenge?: string) {
    super(message);
    this.name = "PmMcpAuthorizationError";
    this.httpStatus = httpStatus;
    this.challenge = challenge;
  }
}

/** RFC 9728 metadata served by a protected pm MCP resource. */
export interface PmMcpProtectedResourceMetadata {
  /** Canonical MCP resource URI used for token audience binding. */
  resource: string;
  /** Independent authorization-server issuers accepted by this resource. */
  authorization_servers: string[];
  /** Minimal scopes used for initial least-privilege authorization. */
  scopes_supported?: string[];
}

/** Validated authorization-server discovery fields needed by MCP clients. */
export interface PmMcpAuthorizationServerMetadata {
  /** Exact issuer identifier. */
  issuer: string;
  /** Authorization endpoint for code flows. */
  authorization_endpoint?: string;
  /** Token endpoint used to redeem authorization codes. */
  token_endpoint?: string;
  /** PKCE methods advertised by the authorization server. */
  code_challenge_methods_supported: string[];
  /** Whether URL-form Client ID Metadata Documents are supported. */
  client_id_metadata_document_supported?: boolean;
  /** Deprecated dynamic-registration fallback endpoint. */
  registration_endpoint?: string;
}

/** Discovery metadata after endpoint and PKCE validation succeeds. */
export interface PmMcpValidatedAuthorizationServerMetadata extends PmMcpAuthorizationServerMetadata {
  /** Validated HTTPS authorization endpoint for code flows. */
  authorization_endpoint: string;
  /** Validated HTTPS token endpoint used to redeem authorization codes. */
  token_endpoint: string;
}

/** Client registration strategy ordered by current MCP preference. */
export type PmMcpClientRegistrationMode =
  | "pre_registered"
  | "client_id_metadata_document"
  | "dynamic"
  | "user_supplied";

/** Bound access-token facts returned by a host-provided verifier. */
export interface PmMcpAccessTokenClaims {
  /** Stable authenticated principal without raw token material. */
  principal: string;
  /** Issuer that minted the token. */
  issuer: string;
  /** Intended resource audiences. */
  audience: string | string[];
  /** Granted OAuth scopes. */
  scopes: string[];
}

/** Policy a Streamable HTTP adapter enforces before dispatching MCP. */
export interface PmMcpHttpAuthorizationPolicy {
  /** Exact accepted issuer. */
  issuer: string;
  /** Exact canonical MCP resource audience. */
  resource: string;
  /** Scopes required for this endpoint or operation. */
  requiredScopes?: string[];
  /** Protected-resource metadata location for RFC 6750 challenges. */
  resourceMetadataUrl: string;
  /** Validate an opaque or structured access token without passing it onward. */
  verifyAccessToken: (
    token: string,
  ) => PmMcpAccessTokenClaims | Promise<PmMcpAccessTokenClaims>;
}

/** W3C trace context accepted from request `_meta`. */
export interface PmMcpTraceContext {
  /** W3C trace-parent value. */
  traceparent?: string;
  /** W3C trace-state value. */
  tracestate?: string;
  /** Allowlisted W3C baggage members only. */
  baggage?: string;
}

const TRACE_PARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const TRACE_STATE_SIMPLE_KEY_PATTERN = /^[a-z][a-z0-9_*/-]{0,255}$/u;
const TRACE_STATE_TENANT_KEY_PATTERN =
  /^(?:[a-z0-9][a-z0-9_*/-]{0,240})@[a-z][a-z0-9_*/-]{0,13}$/u;
const TRACE_STATE_VALUE_PATTERN =
  /^[\x20-\x2B\x2D-\x3C\x3E-\x7E]{0,255}[\x21-\x2B\x2D-\x3C\x3E-\x7E]$/u;
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;
const BAGGAGE_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const BAGGAGE_VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u;
const INVALID_PERCENT_ENCODING_PATTERN = /%(?![0-9A-Fa-f]{2})/u;
const MAX_TRACE_STATE_BYTES = 512;
const MAX_TRACE_STATE_MEMBERS = 32;
const MAX_BAGGAGE_MEMBERS = 180;
const MAX_BAGGAGE_BYTES = 8_192;
const MAX_BEARER_TOKEN_BYTES = 8_192;
const MCP_TRACE_CONTEXT_STORAGE = new AsyncLocalStorage<PmMcpTraceContext>();

function requireAbsoluteAuthorizationUrl(
  value: string,
  field: string,
  allowLocalHttp = false,
): URL {
  if (/\p{Cc}/u.test(value)) {
    throw new PmMcpAuthorizationError(`Invalid ${field}`, 401);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PmMcpAuthorizationError(`Invalid ${field}`, 401);
  }
  const local =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (
    parsed.hash.length > 0 ||
    (parsed.protocol !== "https:" &&
      !(allowLocalHttp && local && parsed.protocol === "http:"))
  ) {
    throw new PmMcpAuthorizationError(`Invalid ${field}`, 401);
  }
  return parsed;
}

function readHeader(
  headers: PmMcpHttpHeaders,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() !== expected || value === undefined) continue;
    return typeof value === "string" ? value : value.join(", ");
  }
  return undefined;
}

/** Build and validate protected-resource metadata for a remote pm endpoint. */
export function buildMcpProtectedResourceMetadata(input: {
  resource: string;
  authorizationServers: readonly string[];
  scopes?: readonly string[];
}): PmMcpProtectedResourceMetadata {
  const resource = requireAbsoluteAuthorizationUrl(
    input.resource,
    "protected resource URI",
    true,
  ).href.replace(/\/$/u, "");
  if (input.authorizationServers.length === 0) {
    throw new PmMcpAuthorizationError(
      "Protected resource metadata requires an authorization server",
      401,
    );
  }
  const authorizationServers = input.authorizationServers.map((issuer) =>
    requireAbsoluteAuthorizationUrl(
      issuer,
      "authorization server issuer",
    ).href.replace(/\/$/u, ""),
  );
  const scopes = [...new Set(input.scopes ?? [])];
  if (scopes.some((scope) => !SCOPE_PATTERN.test(scope))) {
    throw new PmMcpAuthorizationError("Invalid authorization scope", 401);
  }
  return {
    resource,
    authorization_servers: authorizationServers,
    ...(scopes.length > 0 ? { scopes_supported: scopes.sort() } : {}),
  };
}

/** Construct OAuth and OIDC discovery URLs in the MCP-required order. */
export function buildMcpAuthorizationDiscoveryUrls(issuer: string): string[] {
  const parsed = requireAbsoluteAuthorizationUrl(
    issuer,
    "authorization server issuer",
  );
  const suffix = parsed.pathname.replace(/^\/+|\/+$/gu, "");
  const origin = parsed.origin;
  return suffix
    ? [
        `${origin}/.well-known/oauth-authorization-server/${suffix}`,
        `${origin}/.well-known/openid-configuration/${suffix}`,
        `${origin}/${suffix}/.well-known/openid-configuration`,
      ]
    : [
        `${origin}/.well-known/oauth-authorization-server`,
        `${origin}/.well-known/openid-configuration`,
      ];
}

/** Validate authorization-server metadata, exact issuer binding, and S256 PKCE. */
export function validateMcpAuthorizationServerMetadata(
  value: unknown,
  expectedIssuer: string,
): PmMcpValidatedAuthorizationServerMetadata {
  if (!isMcpRecord(value) || typeof value.issuer !== "string") {
    throw new PmMcpAuthorizationError(
      "Invalid authorization server metadata",
      401,
    );
  }
  const expected = requireAbsoluteAuthorizationUrl(
    expectedIssuer,
    "expected issuer",
  ).href.replace(/\/$/u, "");
  const observed = requireAbsoluteAuthorizationUrl(
    value.issuer,
    "metadata issuer",
  ).href.replace(/\/$/u, "");
  if (observed !== expected) {
    throw new PmMcpAuthorizationError(
      "Authorization server issuer mismatch",
      401,
    );
  }
  if (
    !Array.isArray(value.code_challenge_methods_supported) ||
    !value.code_challenge_methods_supported.includes("S256")
  ) {
    throw new PmMcpAuthorizationError(
      "Authorization server does not support required S256 PKCE",
      401,
    );
  }
  const requiredUrl = (field: string): string => {
    const candidate = value[field];
    if (typeof candidate !== "string") {
      throw new PmMcpAuthorizationError(
        `Authorization server metadata requires ${field}`,
        401,
      );
    }
    return requireAbsoluteAuthorizationUrl(candidate, field).href;
  };
  const optionalUrl = (field: string): string | undefined => {
    const candidate = value[field];
    return typeof candidate === "string"
      ? requireAbsoluteAuthorizationUrl(candidate, field).href
      : undefined;
  };
  const authorizationEndpoint = requiredUrl("authorization_endpoint");
  const tokenEndpoint = requiredUrl("token_endpoint");
  const registrationEndpoint = optionalUrl("registration_endpoint");
  return {
    issuer: expected,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    code_challenge_methods_supported: [
      ...new Set(
        value.code_challenge_methods_supported.filter(
          (entry) => typeof entry === "string",
        ),
      ),
    ],
    ...(value.client_id_metadata_document_supported === true
      ? { client_id_metadata_document_supported: true }
      : {}),
    ...(registrationEndpoint
      ? { registration_endpoint: registrationEndpoint }
      : {}),
  };
}

/** Apply the current pre-registration, metadata-document, dynamic, prompt order. */
export function selectMcpClientRegistrationMode(input: {
  hasPreRegisteredClient: boolean;
  metadata: Pick<
    PmMcpAuthorizationServerMetadata,
    "client_id_metadata_document_supported" | "registration_endpoint"
  >;
}): PmMcpClientRegistrationMode {
  if (input.hasPreRegisteredClient) return "pre_registered";
  if (input.metadata.client_id_metadata_document_supported)
    return "client_id_metadata_document";
  if (input.metadata.registration_endpoint) return "dynamic";
  return "user_supplied";
}

/** Validate a present authorization-response issuer before code redemption. */
export function validateMcpAuthorizationResponseIssuer(input: {
  expectedIssuer: string;
  responseIssuer?: string;
  issuerParameterSupported?: boolean;
}): void {
  if (input.responseIssuer === undefined) {
    if (input.issuerParameterSupported) {
      throw new PmMcpAuthorizationError(
        "Authorization response omitted the advertised issuer",
        401,
      );
    }
    return;
  }
  if (input.responseIssuer !== input.expectedIssuer) {
    throw new PmMcpAuthorizationError(
      "Authorization response issuer mismatch",
      401,
    );
  }
}

/** Validate a self-hosted Client ID Metadata Document and exact redirect set. */
export function validateMcpClientMetadataDocument(
  value: unknown,
  documentUrl: string,
): Record<string, unknown> {
  const expected = requireAbsoluteAuthorizationUrl(
    documentUrl,
    "client metadata document URL",
  );
  if (
    expected.pathname === "/" ||
    !isMcpRecord(value) ||
    value.client_id !== expected.href ||
    typeof value.client_name !== "string" ||
    value.client_name.trim().length === 0 ||
    !Array.isArray(value.redirect_uris) ||
    value.redirect_uris.length === 0
  ) {
    throw new PmMcpAuthorizationError(
      "Invalid Client ID Metadata Document",
      401,
    );
  }
  for (const redirect of value.redirect_uris) {
    if (typeof redirect !== "string") {
      throw new PmMcpAuthorizationError("Invalid client redirect URI", 401);
    }
    requireAbsoluteAuthorizationUrl(redirect, "client redirect URI", true);
  }
  return structuredClone(value);
}

/** Build bounded dynamic-registration metadata for explicit legacy fallback. */
export function buildMcpDynamicRegistrationMetadata(input: {
  redirectUris: readonly string[];
  applicationType: "native" | "web";
  clientName: string;
}): Record<string, unknown> {
  if (input.redirectUris.length === 0 || input.clientName.trim().length === 0) {
    throw new PmMcpAuthorizationError(
      "Invalid dynamic client registration metadata",
      401,
    );
  }
  const redirectUris = input.redirectUris.map(
    (redirect) =>
      requireAbsoluteAuthorizationUrl(redirect, "redirect URI", true).href,
  );
  return {
    application_type: input.applicationType,
    client_name: input.clientName.trim().slice(0, 128),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** In-memory issuer-keyed credential primitive that never reuses cross-issuer state. */
export class PmMcpIssuerCredentialStore<
  Credential extends Record<string, unknown>,
> {
  readonly #credentials = new Map<string, Credential>();

  /** Persist a cloned credential under the exact validated issuer. */
  set(issuer: string, credential: Credential): void {
    const key = requireAbsoluteAuthorizationUrl(
      issuer,
      "credential issuer",
    ).href;
    this.#credentials.set(key, structuredClone(credential));
  }

  /** Read a cloned credential only for the exact issuer. */
  get(issuer: string): Credential | undefined {
    const key = requireAbsoluteAuthorizationUrl(
      issuer,
      "credential issuer",
    ).href;
    const credential = this.#credentials.get(key);
    return credential ? structuredClone(credential) : undefined;
  }

  /** Remove credentials for one issuer during revocation or re-registration. */
  delete(issuer: string): boolean {
    const key = requireAbsoluteAuthorizationUrl(
      issuer,
      "credential issuer",
    ).href;
    return this.#credentials.delete(key);
  }
}

function validateMcpTraceFields(
  meta: Record<string, unknown>,
): Pick<PmMcpTraceContext, "traceparent" | "tracestate"> {
  const traceparent = meta.traceparent;
  const tracestate = meta.tracestate;
  if (traceparent !== undefined) {
    const match =
      typeof traceparent === "string"
        ? TRACE_PARENT_PATTERN.exec(traceparent)
        : null;
    if (!match) {
      throw new PmMcpAuthorizationError("Invalid MCP traceparent", 403);
    }
    const traceId = match[1] as string;
    const parentId = match[2] as string;
    if (/^0+$/u.test(traceId) || /^0+$/u.test(parentId)) {
      throw new PmMcpAuthorizationError("Invalid MCP traceparent", 403);
    }
  }
  if (
    tracestate !== undefined &&
    (typeof tracestate !== "string" || !isValidMcpTraceState(tracestate))
  ) {
    throw new PmMcpAuthorizationError("Invalid MCP tracestate", 403);
  }
  return {
    ...(typeof traceparent === "string" ? { traceparent } : {}),
    ...(typeof tracestate === "string" ? { tracestate } : {}),
  };
}

function trimOptionalWhitespace(value: string): string {
  return value.replace(/^[ \t]*|[ \t]*$/gu, "");
}

function isValidMcpTraceStateKey(key: string): boolean {
  return (
    TRACE_STATE_SIMPLE_KEY_PATTERN.test(key) ||
    TRACE_STATE_TENANT_KEY_PATTERN.test(key)
  );
}

function isValidMcpTraceState(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_TRACE_STATE_BYTES) return false;
  const members = value.split(",");
  if (members.length > MAX_TRACE_STATE_MEMBERS) return false;
  const keys = new Set<string>();
  for (const source of members) {
    const member = trimOptionalWhitespace(source);
    if (member.length === 0) continue;
    const separator = member.indexOf("=");
    const key = separator > 0 ? member.slice(0, separator) : "";
    const memberValue = separator > 0 ? member.slice(separator + 1) : "";
    if (
      !isValidMcpTraceStateKey(key) ||
      !TRACE_STATE_VALUE_PATTERN.test(memberValue) ||
      keys.has(key)
    ) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

function isValidMcpBaggageValue(value: string): boolean {
  return (
    BAGGAGE_VALUE_PATTERN.test(value) &&
    !INVALID_PERCENT_ENCODING_PATTERN.test(value)
  );
}

function isValidMcpBaggageProperty(source: string): boolean {
  const property = trimOptionalWhitespace(source);
  const separator = property.indexOf("=");
  const key = trimOptionalWhitespace(
    separator >= 0 ? property.slice(0, separator) : property,
  );
  const value =
    separator >= 0
      ? trimOptionalWhitespace(property.slice(separator + 1))
      : undefined;
  return (
    BAGGAGE_KEY_PATTERN.test(key) &&
    (value === undefined || isValidMcpBaggageValue(value))
  );
}

function parseMcpBaggageMember(
  source: string,
): { key: string; serialized: string } | undefined {
  const serialized = trimOptionalWhitespace(source);
  const segments = serialized.split(";");
  const pair = segments[0] as string;
  const properties = segments.slice(1);
  const separator = pair.indexOf("=");
  const key = trimOptionalWhitespace(
    separator > 0 ? pair.slice(0, separator) : "",
  );
  const value =
    separator > 0 ? trimOptionalWhitespace(pair.slice(separator + 1)) : "";
  if (
    !BAGGAGE_KEY_PATTERN.test(key) ||
    !isValidMcpBaggageValue(value) ||
    !properties.every(isValidMcpBaggageProperty)
  ) {
    return undefined;
  }
  return { key, serialized };
}

function filterMcpBaggage(
  baggage: unknown,
  allowlistEntries: readonly string[],
): string | undefined {
  if (baggage === undefined) return undefined;
  if (
    typeof baggage !== "string" ||
    Buffer.byteLength(baggage, "utf8") > MAX_BAGGAGE_BYTES
  ) {
    throw new PmMcpAuthorizationError("Invalid MCP baggage", 403);
  }
  const allowlist = new Set(allowlistEntries);
  const sources = baggage.split(",");
  if (sources.length > MAX_BAGGAGE_MEMBERS) {
    throw new PmMcpAuthorizationError("Invalid MCP baggage", 403);
  }
  const entries: string[] = [];
  for (const source of sources) {
    const entry = parseMcpBaggageMember(source);
    if (!entry) {
      throw new PmMcpAuthorizationError("Invalid MCP baggage", 403);
    }
    if (allowlist.has(entry.key)) entries.push(entry.serialized);
  }
  return entries.length > 0 ? entries.join(",") : undefined;
}

/** Extract W3C trace context with strict syntax, size, and baggage allowlists. */
export function extractMcpTraceContext(
  params: unknown,
  options: { baggageAllowlist?: readonly string[] } = {},
): PmMcpTraceContext {
  const meta =
    isMcpRecord(params) && isMcpRecord(params._meta) ? params._meta : {};
  const allowedBaggage = filterMcpBaggage(
    meta.baggage,
    options.baggageAllowlist ?? [],
  );
  return {
    ...validateMcpTraceFields(meta),
    ...(allowedBaggage ? { baggage: allowedBaggage } : {}),
  };
}

/** Run one request with trace context isolated from every concurrent request. */
export function runWithMcpTraceContext<Result>(
  context: PmMcpTraceContext,
  callback: () => Result,
): Result {
  return MCP_TRACE_CONTEXT_STORAGE.run(structuredClone(context), callback);
}

/** Read a defensive copy of the current request's trace context. */
export function getActiveMcpTraceContext(): PmMcpTraceContext | undefined {
  const context = MCP_TRACE_CONTEXT_STORAGE.getStore();
  return context ? { ...context } : undefined;
}

/** Enforce bearer location, issuer, audience, and least-privilege scopes. */
export async function authorizeMcpHttpRequest(input: {
  headers: PmMcpHttpHeaders;
  requestUrl: string;
  policy: PmMcpHttpAuthorizationPolicy;
}): Promise<PmMcpAccessTokenClaims> {
  const resourceMetadataUrl = requireAbsoluteAuthorizationUrl(
    input.policy.resourceMetadataUrl,
    "protected resource metadata URL",
    true,
  ).href;
  const requiredScopes = [...new Set(input.policy.requiredScopes ?? [])];
  if (requiredScopes.some((scope) => !SCOPE_PATTERN.test(scope))) {
    throw new PmMcpAuthorizationError("Invalid authorization scope", 401);
  }
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl}"`;
  const parsedUrl = new URL(input.requestUrl, input.policy.resource);
  if (parsedUrl.searchParams.has("access_token")) {
    throw new PmMcpAuthorizationError(
      "Access tokens must not appear in URI query parameters",
      401,
      challenge,
    );
  }
  const authorization = readHeader(input.headers, "authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/iu);
  if (!match) {
    throw new PmMcpAuthorizationError(
      "Missing or malformed bearer token",
      401,
      challenge,
    );
  }
  const token = match[1] as string;
  if (Buffer.byteLength(token, "utf8") > MAX_BEARER_TOKEN_BYTES) {
    throw new PmMcpAuthorizationError(
      "Missing or malformed bearer token",
      401,
      challenge,
    );
  }
  let claims: PmMcpAccessTokenClaims;
  try {
    claims = await input.policy.verifyAccessToken(token);
  } catch {
    throw new PmMcpAuthorizationError("Invalid bearer token", 401, challenge);
  }
  const audiences = Array.isArray(claims.audience)
    ? claims.audience
    : [claims.audience];
  if (
    claims.issuer !== input.policy.issuer ||
    !audiences.includes(input.policy.resource)
  ) {
    throw new PmMcpAuthorizationError(
      "Bearer token issuer or audience mismatch",
      401,
      challenge,
    );
  }
  const missingScopes = requiredScopes.filter(
    (scope) => !claims.scopes.includes(scope),
  );
  if (missingScopes.length > 0) {
    throw new PmMcpAuthorizationError(
      "Bearer token has insufficient scope",
      403,
      `${challenge}, scope="${missingScopes.join(" ")}"`,
    );
  }
  return {
    ...claims,
    audience: [...audiences],
    scopes: [...claims.scopes],
  };
}

/** Create an exact opaque-token verifier without exposing token values in results. */
export function createMcpStaticBearerVerifier(input: {
  token: string;
  claims: PmMcpAccessTokenClaims;
}): (token: string) => PmMcpAccessTokenClaims {
  const expected = createHash("sha256").update(input.token).digest();
  return (token) => {
    const observed = createHash("sha256").update(token).digest();
    if (!timingSafeEqual(expected, observed)) {
      throw new PmMcpAuthorizationError("Invalid bearer token", 401);
    }
    return structuredClone(input.claims);
  };
}
