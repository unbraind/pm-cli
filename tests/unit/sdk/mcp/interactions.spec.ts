import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_INPUT_REQUEST_METHODS,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpInputRequiredError,
  PmMcpProtocolError,
  PmMcpRequestStateReplayGuard,
  buildMcpInputRequiredResult,
  digestMcpRequestParameters,
  openMcpRequestState,
  parseMcpCachePolicy,
  parseMcpInputRequests,
  parseMcpInputResponses,
  resolveMcpRequestContext,
  sealMcpRequestState,
  validateMcpJsonSchema,
  withMcpCachePolicy,
} from "../../../../src/sdk/index.js";

const SERVER_INFO = { name: "pm-mcp", version: "2026.8.25" };
const REQUEST_CONTEXT = resolveMcpRequestContext({
  _meta: {
    [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
    [PM_MCP_META_KEYS.clientCapabilities]: {
      elicitation: {},
      roots: {},
      sampling: {},
    },
  },
});
const SECRET = "s".repeat(32);

function elicitationRequest(message = "Choose a value") {
  return {
    method: "elicitation/create",
    params: {
      mode: "form",
      message,
      requestedSchema: { type: "object" },
    },
  };
}

describe("MCP MRTR interaction contracts", () => {
  it("publishes the exact input method vocabulary and control signal", () => {
    expect(PM_MCP_INPUT_REQUEST_METHODS).toEqual([
      "elicitation/create",
      "roots/list",
      "sampling/createMessage",
    ]);
    const signal = new PmMcpInputRequiredError({
      inputRequests: { choice: elicitationRequest() },
      requestState: "opaque",
    });
    expect(signal).toMatchObject({
      name: "PmMcpInputRequiredError",
      inputRequests: { choice: { method: "elicitation/create" } },
      requestState: "opaque",
    });
  });

  it("validates every supported input request and response shape", () => {
    expect(
      parseMcpInputRequests(
        {
          choice: elicitationRequest(),
          roots: { method: "roots/list", params: {} },
          sample: {
            method: "sampling/createMessage",
            params: { messages: [], maxTokens: 8 },
          },
        },
        REQUEST_CONTEXT,
      ),
    ).toEqual({
      choice: elicitationRequest(),
      roots: { method: "roots/list", params: {} },
      sample: {
        method: "sampling/createMessage",
        params: { messages: [], maxTokens: 8 },
      },
    });
    expect(
      parseMcpInputResponses({ choice: { action: "accept", content: 7 } }),
    ).toEqual({ choice: { action: "accept", content: 7 } });
  });

  it("rejects malformed, excessive, unsupported, and unnegotiated input requests", () => {
    for (const value of [null, []]) {
      expect(() => parseMcpInputRequests(value, REQUEST_CONTEXT)).toThrow(
        /Invalid MCP inputRequests/u,
      );
    }
    expect(() => parseMcpInputRequests({}, REQUEST_CONTEXT)).toThrow(/count/u);
    expect(() =>
      parseMcpInputRequests(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `request_${index}`,
            elicitationRequest(),
          ]),
        ),
        REQUEST_CONTEXT,
      ),
    ).toThrow(/count/u);
    expect(() =>
      parseMcpInputRequests(
        { "bad key": elicitationRequest() },
        REQUEST_CONTEXT,
      ),
    ).toThrow(/entry/u);
    expect(() =>
      parseMcpInputRequests({ choice: "request" }, REQUEST_CONTEXT),
    ).toThrow(/entry/u);
    expect(() =>
      parseMcpInputRequests(
        { choice: { method: "future/request", params: {} } },
        REQUEST_CONTEXT,
      ),
    ).toThrow(/Unsupported/u);
    expect(() =>
      parseMcpInputRequests({ choice: { params: {} } }, REQUEST_CONTEXT),
    ).toThrow(/Unsupported/u);
    expect(() =>
      parseMcpInputRequests(
        { choice: { method: "elicitation/create", params: [] } },
        REQUEST_CONTEXT,
      ),
    ).toThrow(/parameters/u);
    const noCapabilities = resolveMcpRequestContext({
      _meta: {
        [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
        [PM_MCP_META_KEYS.clientCapabilities]: {},
      },
    });
    expect(() =>
      parseMcpInputRequests({ choice: elicitationRequest() }, noCapabilities),
    ).toThrow(/Missing required client capability/u);
    expect(() =>
      parseMcpInputRequests(
        { choice: elicitationRequest("x".repeat(70_000)) },
        REQUEST_CONTEXT,
      ),
    ).toThrow(/payload exceeds/u);
  });

  it("rejects malformed and excessive input responses", () => {
    for (const value of [null, []]) {
      expect(() => parseMcpInputResponses(value)).toThrow(/inputResponses/u);
    }
    expect(() =>
      parseMcpInputResponses(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `response_${index}`,
            { action: "accept" },
          ]),
        ),
      ),
    ).toThrow(/count/u);
    expect(() =>
      parseMcpInputResponses({ "bad key": { action: "accept" } }),
    ).toThrow(/entry/u);
    expect(() => parseMcpInputResponses({ choice: [] })).toThrow(/entry/u);
    expect(() =>
      parseMcpInputResponses({ choice: { text: "x".repeat(70_000) } }),
    ).toThrow(/payload exceeds/u);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseMcpInputResponses({ choice: circular })).toThrow(
      /not JSON serializable/u,
    );
  });

  it("builds capability-checked input-required results", () => {
    expect(
      buildMcpInputRequiredResult({
        requestContext: REQUEST_CONTEXT,
        serverInfo: SERVER_INFO,
        inputRequests: { choice: elicitationRequest() },
        requestState: "opaque-state",
      }),
    ).toEqual({
      resultType: "input_required",
      inputRequests: { choice: elicitationRequest() },
      requestState: "opaque-state",
      _meta: { [PM_MCP_META_KEYS.serverInfo]: SERVER_INFO },
    });
    expect(
      buildMcpInputRequiredResult({
        requestContext: REQUEST_CONTEXT,
        serverInfo: SERVER_INFO,
        requestState: "state-only",
      }),
    ).not.toHaveProperty("inputRequests");
    expect(
      buildMcpInputRequiredResult({
        requestContext: REQUEST_CONTEXT,
        serverInfo: SERVER_INFO,
        inputRequests: { choice: elicitationRequest() },
      }),
    ).not.toHaveProperty("requestState");
    expect(() =>
      buildMcpInputRequiredResult({
        requestContext: REQUEST_CONTEXT,
        serverInfo: SERVER_INFO,
      }),
    ).toThrow(/requires inputRequests or requestState/u);
    expect(() =>
      buildMcpInputRequiredResult({
        requestContext: REQUEST_CONTEXT,
        serverInfo: SERVER_INFO,
        requestState: "x".repeat(17_000),
      }),
    ).toThrow(/requestState/u);
  });

  it("seals and verifies state bound to method, parameters, principal, and expiry", () => {
    const payload = {
      expiresAt: 2_000,
      method: "tools/call",
      parameterDigest: "digest",
      principal: "user:1",
      state: { step: 2 },
    };
    const sealed = sealMcpRequestState(payload, SECRET);
    expect(
      openMcpRequestState(sealed, SECRET, {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
        nowMs: 1_000,
      }),
    ).toEqual(payload);
    expect(() => sealMcpRequestState(payload, "short")).toThrow(/32 bytes/u);
    for (const invalid of [
      { ...payload, expiresAt: 0 },
      { ...payload, method: " " },
      { ...payload, parameterDigest: " " },
      { ...payload, principal: " " },
    ]) {
      expect(() => sealMcpRequestState(invalid, SECRET)).toThrow(/payload/u);
    }
    expect(() =>
      sealMcpRequestState({ ...payload, state: "x".repeat(9000) }, SECRET),
    ).toThrow(/exceeds/u);
    expect(() =>
      openMcpRequestState("bad", SECRET, {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
      }),
    ).toThrow(/encoding/u);
    const [body, signature] = sealed.split(".");
    expect(() =>
      openMcpRequestState(`${body}.${signature}x`, SECRET, {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
      }),
    ).toThrow(/signature/u);
    expect(() =>
      openMcpRequestState(sealed, "t".repeat(32), {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
      }),
    ).toThrow(/signature/u);
    expect(() =>
      openMcpRequestState(sealed, SECRET, {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
        nowMs: 2_001,
      }),
    ).toThrow(/Expired/u);
    expect(() =>
      openMcpRequestState(sealed, SECRET, {
        method: "prompts/get",
        parameterDigest: "digest",
        principal: "user:1",
        nowMs: 1_000,
      }),
    ).toThrow(/binding mismatch/u);

    const invalidBody = Buffer.from("not-json", "utf8").toString("base64url");
    const invalidSignature = createHmac("sha256", SECRET)
      .update(invalidBody)
      .digest("base64url");
    expect(() =>
      openMcpRequestState(`${invalidBody}.${invalidSignature}`, SECRET, {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
      }),
    ).toThrow(/payload/u);

    const malformedPayloadBody = Buffer.from(
      JSON.stringify({ version: 1, expiresAt: "later" }),
      "utf8",
    ).toString("base64url");
    const malformedPayloadSignature = createHmac("sha256", SECRET)
      .update(malformedPayloadBody)
      .digest("base64url");
    expect(() =>
      openMcpRequestState(
        `${malformedPayloadBody}.${malformedPayloadSignature}`,
        SECRET,
        {
          method: "tools/call",
          parameterDigest: "digest",
          principal: "user:1",
        },
      ),
    ).toThrow(/payload/u);

    const missingBindingBody = Buffer.from(
      JSON.stringify({ version: 1, expiresAt: 2_000 }),
      "utf8",
    ).toString("base64url");
    const missingBindingSignature = createHmac("sha256", SECRET)
      .update(missingBindingBody)
      .digest("base64url");
    expect(() =>
      openMcpRequestState(
        `${missingBindingBody}.${missingBindingSignature}`,
        SECRET,
        {
          method: "tools/call",
          parameterDigest: "digest",
          principal: "user:1",
          nowMs: 1_000,
        },
      ),
    ).toThrow(/payload/u);

    const future = sealMcpRequestState(
      { ...payload, expiresAt: Date.now() + 60_000 },
      SECRET,
    );
    expect(() =>
      openMcpRequestState(future, SECRET, {
        method: "tools/call",
        parameterDigest: "digest",
        principal: "user:1",
      }),
    ).not.toThrow();
  });

  it("digests bounded request data and rejects circular or excessive data", () => {
    expect(digestMcpRequestParameters({ b: 2 })).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => digestMcpRequestParameters("x".repeat(70_000))).toThrow(
      /payload exceeds/u,
    );
    const circular: Record<string, unknown> = {};
    circular.circular = circular;
    expect(() => digestMcpRequestParameters(circular)).toThrow(/serializable/u);
  });

  it("detects request-state replay with bounded eviction", () => {
    expect(() => new PmMcpRequestStateReplayGuard(0)).toThrow(/capacity/u);
    const guard = new PmMcpRequestStateReplayGuard(2);
    guard.consume("one");
    guard.consume("two");
    expect(() => guard.consume("two")).toThrow(/replay/u);
    guard.consume("three");
    expect(() => guard.consume("one")).not.toThrow();
  });
});

describe("MCP cache and JSON Schema contracts", () => {
  it("attaches validated public and private cache policies", () => {
    expect(parseMcpCachePolicy({ ttlMs: 0, cacheScope: "private" })).toEqual({
      ttlMs: 0,
      cacheScope: "private",
    });
    expect(
      withMcpCachePolicy(
        { tools: [] },
        { ttlMs: 30_000, cacheScope: "public" },
      ),
    ).toEqual({ tools: [], ttlMs: 30_000, cacheScope: "public" });
    for (const policy of [
      { ttlMs: -1, cacheScope: "public" as const },
      { ttlMs: 1.5, cacheScope: "public" as const },
      { ttlMs: 1, cacheScope: "shared" as "public" },
    ]) {
      expect(() => parseMcpCachePolicy(policy)).toThrow(PmMcpProtocolError);
    }
  });

  it("accepts JSON Schema 2020-12 composition, local references, and booleans", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { name: { type: "string" } },
      type: "object",
      properties: { name: { $ref: "#/$defs/name" } },
      allOf: [
        JSON.parse(
          '{"if":{"required":["name"]},"then":{"minProperties":1}}',
        ) as Record<string, unknown>,
      ],
      unevaluatedProperties: false,
    };
    expect(validateMcpJsonSchema(schema)).toEqual(schema);
    expect(validateMcpJsonSchema(true)).toBe(true);
    expect(validateMcpJsonSchema({ $ref: "#" })).toEqual({ $ref: "#" });
    expect(
      validateMcpJsonSchema({ $ref: "https://schemas.example.test/name" }),
    ).toEqual({ $ref: "https://schemas.example.test/name" });
  });

  it("fails closed on invalid schemas, references, and work bounds", () => {
    expect(() => validateMcpJsonSchema([])).toThrow(/root/u);
    for (const bounds of [{ maxBytes: 1 }, { maxDepth: 0 }, { maxNodes: 0 }]) {
      expect(() => validateMcpJsonSchema({}, bounds)).toThrow(/work bounds/u);
    }
    expect(() =>
      validateMcpJsonSchema({ $defs: {}, $ref: "#/$defs/missing" }),
    ).toThrow(/unresolved local reference/u);
    expect(() =>
      validateMcpJsonSchema({
        $defs: { name: "text" },
        $ref: "#/$defs/name/x",
      }),
    ).toThrow(/unresolved local reference/u);
    expect(() => validateMcpJsonSchema({ $ref: "#future" })).toThrow(
      /unresolved local reference/u,
    );
    expect(() =>
      validateMcpJsonSchema({ description: "x".repeat(100) }, { maxBytes: 20 }),
    ).toThrow(/payload exceeds/u);
    expect(() =>
      validateMcpJsonSchema(
        { properties: { nested: { type: "string" } } },
        { maxDepth: 1 },
      ),
    ).toThrow(/validation work bounds/u);
    expect(() =>
      validateMcpJsonSchema({ anyOf: [{}, {}] }, { maxNodes: 2 }),
    ).toThrow(/validation work bounds/u);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateMcpJsonSchema(circular)).toThrow(/serializable/u);
  });

  it("uses the allocated invalid-params error for schema refusals", () => {
    try {
      validateMcpJsonSchema("string");
      throw new Error("expected schema refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: PM_MCP_ERROR_CODES.invalidParams });
    }
  });
});
