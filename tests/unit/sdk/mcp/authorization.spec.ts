import { describe, expect, it } from "vitest";
import {
  PmMcpAuthorizationError,
  PmMcpIssuerCredentialStore,
  authorizeMcpHttpRequest,
  buildMcpAuthorizationDiscoveryUrls,
  buildMcpDynamicRegistrationMetadata,
  buildMcpProtectedResourceMetadata,
  createMcpStaticBearerVerifier,
  extractMcpTraceContext,
  getActiveMcpTraceContext,
  runWithMcpTraceContext,
  selectMcpClientRegistrationMode,
  validateMcpAuthorizationResponseIssuer,
  validateMcpAuthorizationServerMetadata,
  validateMcpClientMetadataDocument,
} from "../../../../src/sdk/index.js";

describe("MCP remote authorization and trace contracts", () => {
  it("builds strict protected-resource metadata", () => {
    expect(
      buildMcpProtectedResourceMetadata({
        resource: "https://mcp.example.test/mcp/",
        authorizationServers: ["https://auth.example.test/"],
        scopes: ["pm:write", "pm:read", "pm:read"],
      }),
    ).toEqual({
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://auth.example.test"],
      scopes_supported: ["pm:read", "pm:write"],
    });
    expect(
      buildMcpProtectedResourceMetadata({
        resource: "http://127.0.0.1:3000/mcp",
        authorizationServers: ["https://auth.example.test"],
      }),
    ).not.toHaveProperty("scopes_supported");
    for (const input of [
      {
        resource: "not-a-url",
        authorizationServers: ["https://auth.example.test"],
      },
      { resource: "https://mcp.example.test", authorizationServers: [] },
      {
        resource: "https://mcp.example.test",
        authorizationServers: ["http://auth.example.test"],
      },
      {
        resource: "https://mcp.example.test",
        authorizationServers: ["https://auth.example.test"],
        scopes: ["bad scope"],
      },
    ]) {
      expect(() => buildMcpProtectedResourceMetadata(input)).toThrow(
        PmMcpAuthorizationError,
      );
    }
  });

  it("constructs ordered OAuth and OIDC discovery endpoints", () => {
    expect(
      buildMcpAuthorizationDiscoveryUrls("https://auth.example.test/tenant1"),
    ).toEqual([
      "https://auth.example.test/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.test/.well-known/openid-configuration/tenant1",
      "https://auth.example.test/tenant1/.well-known/openid-configuration",
    ]);
    expect(
      buildMcpAuthorizationDiscoveryUrls("https://auth.example.test"),
    ).toEqual([
      "https://auth.example.test/.well-known/oauth-authorization-server",
      "https://auth.example.test/.well-known/openid-configuration",
    ]);
    expect(
      buildMcpAuthorizationDiscoveryUrls("https://auth.example.test/tenant1/"),
    ).toEqual([
      "https://auth.example.test/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.test/.well-known/openid-configuration/tenant1",
      "https://auth.example.test/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("validates exact issuer metadata and mandatory S256 PKCE", () => {
    const metadata = validateMcpAuthorizationServerMetadata(
      {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        token_endpoint: "https://auth.example.test/token",
        code_challenge_methods_supported: ["S256", "S256"],
        client_id_metadata_document_supported: true,
        registration_endpoint: "https://auth.example.test/register",
      },
      "https://auth.example.test",
    );
    expect(metadata).toMatchObject({
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      registration_endpoint: "https://auth.example.test/register",
    });
    expect(
      validateMcpAuthorizationServerMetadata(
        {
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          code_challenge_methods_supported: ["S256", 7],
        },
        "https://auth.example.test",
      ),
    ).toEqual({
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      code_challenge_methods_supported: ["S256"],
    });
    for (const value of [
      null,
      {
        issuer: "https://other.example.test",
        code_challenge_methods_supported: ["S256"],
      },
      {
        issuer: "https://auth.example.test",
        code_challenge_methods_supported: [],
      },
      {
        issuer: "https://auth.example.test",
        code_challenge_methods_supported: ["S256"],
      },
      {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        code_challenge_methods_supported: ["S256"],
      },
      {
        issuer: "https://auth.example.test",
        token_endpoint: "https://auth.example.test/token",
        code_challenge_methods_supported: ["S256"],
      },
      {
        issuer: "https://auth.example.test",
        authorization_endpoint: "https://auth.example.test/authorize",
        code_challenge_methods_supported: ["S256"],
        token_endpoint: "http://auth.example.test/token",
      },
    ]) {
      expect(() =>
        validateMcpAuthorizationServerMetadata(
          value,
          "https://auth.example.test",
        ),
      ).toThrow(PmMcpAuthorizationError);
    }
  });

  it("selects modern registration first and validates response issuers", () => {
    expect(
      selectMcpClientRegistrationMode({
        hasPreRegisteredClient: true,
        metadata: {},
      }),
    ).toBe("pre_registered");
    expect(
      selectMcpClientRegistrationMode({
        hasPreRegisteredClient: false,
        metadata: { client_id_metadata_document_supported: true },
      }),
    ).toBe("client_id_metadata_document");
    expect(
      selectMcpClientRegistrationMode({
        hasPreRegisteredClient: false,
        metadata: { registration_endpoint: "https://auth.test/register" },
      }),
    ).toBe("dynamic");
    expect(
      selectMcpClientRegistrationMode({
        hasPreRegisteredClient: false,
        metadata: {},
      }),
    ).toBe("user_supplied");
    expect(() =>
      validateMcpAuthorizationResponseIssuer({
        expectedIssuer: "https://auth.test",
      }),
    ).not.toThrow();
    expect(() =>
      validateMcpAuthorizationResponseIssuer({
        expectedIssuer: "https://auth.test",
        responseIssuer: "https://auth.test",
        issuerParameterSupported: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateMcpAuthorizationResponseIssuer({
        expectedIssuer: "https://auth.test",
        issuerParameterSupported: true,
      }),
    ).toThrow(/omitted/u);
    expect(() =>
      validateMcpAuthorizationResponseIssuer({
        expectedIssuer: "https://auth.test",
        responseIssuer: "https://attacker.test",
      }),
    ).toThrow(/mismatch/u);
  });

  it("validates metadata documents and bounded dynamic fallback", () => {
    const documentUrl = "https://client.example.test/oauth/client.json";
    const document = {
      client_id: documentUrl,
      client_name: "pm client",
      redirect_uris: ["http://127.0.0.1:4567/callback"],
    };
    expect(validateMcpClientMetadataDocument(document, documentUrl)).toEqual(
      document,
    );
    for (const value of [
      { ...document, client_id: "https://other.test/client.json" },
      { ...document, client_name: "" },
      { ...document, redirect_uris: [] },
      { ...document, redirect_uris: [7] },
      { ...document, redirect_uris: ["http://remote.example.test/callback"] },
    ]) {
      expect(() =>
        validateMcpClientMetadataDocument(value, documentUrl),
      ).toThrow(PmMcpAuthorizationError);
    }
    expect(() =>
      validateMcpClientMetadataDocument(
        document,
        "https://client.example.test",
      ),
    ).toThrow(PmMcpAuthorizationError);
    expect(
      buildMcpDynamicRegistrationMetadata({
        applicationType: "native",
        clientName: `  ${"x".repeat(140)}  `,
        redirectUris: ["http://localhost:4567/callback"],
      }),
    ).toMatchObject({
      application_type: "native",
      client_name: "x".repeat(128),
      redirect_uris: ["http://localhost:4567/callback"],
    });
    expect(() =>
      buildMcpDynamicRegistrationMetadata({
        applicationType: "web",
        clientName: "",
        redirectUris: [],
      }),
    ).toThrow(/dynamic client/u);
  });

  it("keeps client credentials exact-issuer bound and defensively cloned", () => {
    const store = new PmMcpIssuerCredentialStore<{ clientId: string }>();
    const credential = { clientId: "one" };
    store.set("https://auth.example.test", credential);
    credential.clientId = "mutated";
    const first = store.get("https://auth.example.test");
    expect(first).toEqual({ clientId: "one" });
    if (first) first.clientId = "also-mutated";
    expect(store.get("https://auth.example.test")).toEqual({ clientId: "one" });
    expect(store.get("https://other.example.test")).toBeUndefined();
    store.set("https://auth.example.test/tenant", { clientId: "tenant" });
    expect(store.get("https://auth.example.test/tenant/")).toBeUndefined();
    expect(store.delete("https://auth.example.test")).toBe(true);
    expect(store.delete("https://auth.example.test")).toBe(false);
  });

  it("validates and allowlists isolated W3C trace context", async () => {
    const params = {
      _meta: {
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01",
        tracestate: "vendor=value,1@system=tenant, ",
        baggage: "tenant=public;sampled=true;flag,token=secret",
      },
    };
    const context = extractMcpTraceContext(params, {
      baggageAllowlist: ["tenant"],
    });
    expect(context).toEqual({
      traceparent: params._meta.traceparent,
      tracestate: "vendor=value,1@system=tenant, ",
      baggage: "tenant=public;sampled=true;flag",
    });
    expect(
      extractMcpTraceContext({ _meta: { baggage: "token=secret" } }),
    ).toEqual({});
    expect(extractMcpTraceContext(undefined)).toEqual({});
    expect(getActiveMcpTraceContext()).toBeUndefined();
    await runWithMcpTraceContext(context, async () => {
      expect(getActiveMcpTraceContext()).toEqual(context);
      await Promise.resolve();
      expect(getActiveMcpTraceContext()).toEqual(context);
    });
    expect(getActiveMcpTraceContext()).toBeUndefined();
    for (const invalid of [
      { traceparent: 7 },
      { traceparent: "bad" },
      {
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      },
      {
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",
      },
      { tracestate: "line\nfeed" },
      { tracestate: "not-a-member" },
      { tracestate: "vendor=value,vendor=duplicate" },
      { tracestate: "Vendor=value" },
      { tracestate: "vendor=" },
      { tracestate: "vendor=bad=value" },
      { tracestate: `vendor=${"x".repeat(513)}` },
      {
        tracestate: Array.from(
          { length: 33 },
          (_value, index) => `vendor${index}=value`,
        ).join(","),
      },
      { baggage: "tenant=ok\r\nInjected: value" },
      { baggage: "missing-separator" },
      { baggage: "tenant=value;invalid property" },
      { baggage: "tenant=value;flag=bad%value" },
      { baggage: "tenant=bad%value" },
      {
        baggage: Array.from(
          { length: 181 },
          (_value, index) => `key${index}=value`,
        ).join(","),
      },
      { baggage: "x".repeat(8_193) },
    ]) {
      expect(() => extractMcpTraceContext({ _meta: invalid })).toThrow(
        PmMcpAuthorizationError,
      );
    }
  });

  it("enforces bearer placement, issuer, audience, scopes, and static tokens", async () => {
    const claims = {
      principal: "agent-1",
      issuer: "https://auth.example.test",
      audience: "https://mcp.example.test/mcp",
      scopes: ["pm:read", "pm:write"],
    };
    const policy = {
      issuer: claims.issuer,
      resource: claims.audience,
      requiredScopes: ["pm:read"],
      resourceMetadataUrl:
        "https://mcp.example.test/.well-known/oauth-protected-resource",
      verifyAccessToken: createMcpStaticBearerVerifier({
        token: "correct-token",
        claims,
      }),
    };
    await expect(
      authorizeMcpHttpRequest({
        headers: { AUTHORIZATION: ["Bearer correct-token"] },
        requestUrl: "https://mcp.example.test/mcp",
        policy,
      }),
    ).resolves.toEqual({ ...claims, audience: [claims.audience] });
    await expect(
      authorizeMcpHttpRequest({
        headers: { authorization: "bearer correct-token" },
        requestUrl: "https://mcp.example.test/mcp",
        policy: { ...policy, requiredScopes: undefined },
      }),
    ).resolves.toMatchObject({ principal: claims.principal });
    for (const input of [
      { headers: {}, requestUrl: "https://mcp.example.test/mcp" },
      {
        headers: { authorization: "Bearer wrong-token" },
        requestUrl: "https://mcp.example.test/mcp",
      },
      {
        headers: { authorization: "Bearer correct-token" },
        requestUrl: "https://mcp.example.test/mcp?access_token=bad",
      },
    ]) {
      await expect(
        authorizeMcpHttpRequest({ ...input, policy }),
      ).rejects.toMatchObject({
        httpStatus: 401,
        challenge: expect.stringContaining("resource_metadata"),
      });
    }
    await expect(
      authorizeMcpHttpRequest({
        headers: { authorization: `Bearer ${"x".repeat(8_193)}` },
        requestUrl: "https://mcp.example.test/mcp",
        policy,
      }),
    ).rejects.toBeInstanceOf(PmMcpAuthorizationError);
    await expect(
      authorizeMcpHttpRequest({
        headers: { authorization: "Bearer token" },
        requestUrl: "https://mcp.example.test/mcp",
        policy: {
          ...policy,
          verifyAccessToken: () => ({
            ...claims,
            issuer: "https://other.test",
          }),
        },
      }),
    ).rejects.toThrow(/issuer or audience/u);
    await expect(
      authorizeMcpHttpRequest({
        headers: { authorization: "Bearer token" },
        requestUrl: "https://mcp.example.test/mcp",
        policy: {
          ...policy,
          requiredScopes: ["pm:admin"],
          verifyAccessToken: () => ({ ...claims, audience: [claims.audience] }),
        },
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    for (const invalidPolicy of [
      {
        ...policy,
        resourceMetadataUrl: "https://mcp.example.test/\r\nInjected: value",
      },
      { ...policy, requiredScopes: ['pm:read"'] },
      { ...policy, requiredScopes: ["pm:read\r\nInjected: value"] },
    ]) {
      await expect(
        authorizeMcpHttpRequest({
          headers: {},
          requestUrl: "https://mcp.example.test/mcp",
          policy: invalidPolicy,
        }),
      ).rejects.toMatchObject({ httpStatus: 401, challenge: undefined });
    }
    await expect(
      authorizeMcpHttpRequest({
        headers: {},
        requestUrl: "https://mcp.example.test/mcp",
        policy: {
          ...policy,
          resourceMetadataUrl: 'https://mcp.example.test/.well-known/"metadata',
        },
      }),
    ).rejects.toMatchObject({
      challenge:
        'Bearer resource_metadata="https://mcp.example.test/.well-known/%22metadata"',
    });
  });
});
