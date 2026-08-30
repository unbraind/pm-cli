import { describe, expect, it } from "vitest";
import {
  PM_MCP_ERROR_CODES,
  PM_MCP_LEGACY_PROTOCOL_VERSIONS,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PM_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  PmMcpProtocolError,
  assertMcpClientCapabilities,
  assertMcpProtocolHeader,
  buildMcpCompleteResult,
  buildMcpDiscoverResult,
  interpretMcpResultType,
  isMcpRecord,
  parseMcpImplementation,
  resolveMcpRequestContext,
} from "../../../../src/sdk/index.js";

const MODERN_META = {
  [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
  [PM_MCP_META_KEYS.clientCapabilities]: { elicitation: {} },
  [PM_MCP_META_KEYS.clientInfo]: {
    name: "test-host",
    version: "1.2.3",
  },
};

describe("MCP 2026-07-28 SDK protocol contracts", () => {
  it("publishes canonical modern, legacy, metadata, and error vocabularies", () => {
    expect(PM_MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(PM_MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2026-07-28"]);
    // Legacy is every initialize-era revision the canonical spec names, newest
    // first, not a single historical revision.
    expect(PM_MCP_LEGACY_PROTOCOL_VERSIONS).toEqual([
      "2025-11-25",
      "2025-06-18",
    ]);
    expect(PM_MCP_ERROR_CODES).toEqual({
      headerMismatch: -32020,
      missingRequiredClientCapability: -32021,
      unsupportedProtocolVersion: -32022,
      invalidParams: -32602,
    });
    expect(PM_MCP_META_KEYS.serverInfo).toBe(
      "io.modelcontextprotocol/serverInfo",
    );
  });

  it("recognizes records and validates bounded implementation identities", () => {
    expect(isMcpRecord({})).toBe(true);
    expect(isMcpRecord([])).toBe(false);
    expect(isMcpRecord(null)).toBe(false);
    expect(parseMcpImplementation(undefined)).toBeUndefined();
    expect(() => parseMcpImplementation("host")).toThrow(
      PmMcpProtocolError,
    );
    expect(() => parseMcpImplementation({ name: "host" })).toThrow(
      PmMcpProtocolError,
    );
    expect(() =>
      parseMcpImplementation({ name: 7, version: "1" }),
    ).toThrow(PmMcpProtocolError);
    expect(() =>
      parseMcpImplementation({ name: " ", version: " " }),
    ).toThrow(PmMcpProtocolError);
    expect(
      parseMcpImplementation({
        name: `  ${"n".repeat(140)}  `,
        version: `  ${"v".repeat(140)}  `,
        description: "  project context host  ",
        websiteUrl: "  https://example.test/host  ",
      }),
    ).toEqual({
      name: "n".repeat(128),
      version: "v".repeat(128),
      description: "project context host",
      websiteUrl: "https://example.test/host",
    });
    expect(
      parseMcpImplementation({
        name: "host",
        version: "1",
        description: 3,
        websiteUrl: " ",
      }),
    ).toEqual({ name: "host", version: "1" });
  });

  it("requires version and capabilities independently on every request", () => {
    expect(() => resolveMcpRequestContext(undefined)).toThrow(
      /Missing required MCP request metadata/u,
    );
    expect(() => resolveMcpRequestContext({ _meta: [] })).toThrow(
      /Missing required MCP request metadata/u,
    );
    for (const requested of [undefined, "1900-01-01"]) {
      try {
        resolveMcpRequestContext({
          _meta: {
            ...MODERN_META,
            [PM_MCP_META_KEYS.protocolVersion]: requested,
          },
        });
        throw new Error("Expected unsupported protocol error");
      } catch (error) {
        expect(error).toMatchObject({
          code: PM_MCP_ERROR_CODES.unsupportedProtocolVersion,
          data: {
            supported: [PM_MCP_PROTOCOL_VERSION],
            requested: requested ?? null,
          },
        });
      }
    }
    expect(() =>
      resolveMcpRequestContext({
        _meta: {
          ...MODERN_META,
          [PM_MCP_META_KEYS.clientCapabilities]: [],
        },
      }),
    ).toThrow(/Invalid MCP client capabilities metadata/u);
    expect(
      resolveMcpRequestContext({ _meta: MODERN_META }),
    ).toEqual({
      protocolVersion: PM_MCP_PROTOCOL_VERSION,
      clientCapabilities: { elicitation: {} },
      clientInfo: { name: "test-host", version: "1.2.3" },
    });
    expect(
      resolveMcpRequestContext({
        _meta: {
          [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
          [PM_MCP_META_KEYS.clientCapabilities]: {},
        },
      }),
    ).toEqual({
      protocolVersion: PM_MCP_PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  });

  it("validates HTTP header parity and request-local capabilities", () => {
    const context = resolveMcpRequestContext({ _meta: MODERN_META });
    expect(() =>
      assertMcpProtocolHeader(context, PM_MCP_PROTOCOL_VERSION),
    ).not.toThrow();
    for (const header of [undefined, "2025-06-18"]) {
      expect(() => assertMcpProtocolHeader(context, header)).toThrow(
        PmMcpProtocolError,
      );
    }
    expect(() =>
      assertMcpClientCapabilities(context, ["elicitation"]),
    ).not.toThrow();
    try {
      assertMcpClientCapabilities(context, ["elicitation", "sampling"]);
      throw new Error("Expected missing capability error");
    } catch (error) {
      expect(error).toMatchObject({
        code: PM_MCP_ERROR_CODES.missingRequiredClientCapability,
        data: { requiredCapabilities: { sampling: {} } },
      });
    }
  });

  it("builds deterministic discovery and complete result envelopes", () => {
    const serverInfo = { name: "pm-mcp", version: "2026.8.25" };
    expect(
      buildMcpCompleteResult(
        { value: 1, resultType: "stale", _meta: { stale: true } },
        serverInfo,
      ),
    ).toEqual({
      value: 1,
      resultType: "complete",
      _meta: {
        stale: true,
        [PM_MCP_META_KEYS.serverInfo]: serverInfo,
      },
    });
    expect(
      buildMcpDiscoverResult({
        serverInfo,
        capabilities: { tools: { listChanged: true }, extensions: {} },
        instructions: "Use pm_context first.",
      }),
    ).toMatchObject({
      supportedVersions: [PM_MCP_PROTOCOL_VERSION],
      capabilities: { tools: { listChanged: true }, extensions: {} },
      instructions: "Use pm_context first.",
      ttlMs: 60_000,
      cacheScope: "public",
      resultType: "complete",
      _meta: { [PM_MCP_META_KEYS.serverInfo]: serverInfo },
    });
    expect(
      buildMcpDiscoverResult({
        serverInfo,
        capabilities: {},
        ttlMs: 0,
      }),
    ).not.toHaveProperty("instructions");
    for (const ttlMs of [-1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        buildMcpDiscoverResult({ serverInfo, capabilities: {}, ttlMs }),
      ).toThrow(/Invalid MCP discovery cache TTL/u);
    }
  });

  it("isolates omitted resultType compatibility to explicit legacy reads", () => {
    expect(interpretMcpResultType({ resultType: "input_required" }, "modern"))
      .toBe("input_required");
    expect(interpretMcpResultType({}, "legacy")).toBe("complete");
    expect(() => interpretMcpResultType([], "modern")).toThrow(
      /missing resultType/u,
    );
  });
});
