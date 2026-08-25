import { describe, expect, it } from "vitest";
import {
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
  buildMcpHttpRequestHeaders,
  collectMcpHeaderAnnotations,
  decodeMcpHttpHeaderValue,
  encodeMcpHttpHeaderValue,
  validateMcpHttpRequestHeaders,
} from "../../../../src/sdk/index.js";

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
        [PM_MCP_META_KEYS.clientCapabilities]: {},
      },
    },
  };
}

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": "Region" },
    options: {
      type: "object",
      properties: {
        retries: { type: "integer", "x-mcp-header": "Retries" },
        active: { type: "boolean", "x-mcp-header": "Active" },
      },
    },
  },
};

describe("MCP Streamable HTTP transport contracts", () => {
  it("encodes unsafe values and strictly decodes the Base64 sentinel", () => {
    expect(encodeMcpHttpHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeMcpHttpHeaderValue(42)).toBe("42");
    expect(encodeMcpHttpHeaderValue(false)).toBe("false");
    expect(encodeMcpHttpHeaderValue("Hello, 世界")).toBe(
      "=?base64?SGVsbG8sIOS4lueVjA==?=",
    );
    expect(encodeMcpHttpHeaderValue(" padded ")).toMatch(/^=\?base64\?/u);
    expect(encodeMcpHttpHeaderValue("=?base64?literal?=")).toMatch(
      /^=\?base64\?/u,
    );
    expect(decodeMcpHttpHeaderValue("plain", "Mcp-Name")).toBe("plain");
    expect(
      decodeMcpHttpHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=", "Mcp-Name"),
    ).toBe("Hello, 世界");
    for (const value of ["", " padded ", "line\nfeed", "=?base64?A?="]) {
      expect(() => decodeMcpHttpHeaderValue(value, "Mcp-Name")).toThrow(
        PmMcpProtocolError,
      );
    }
  });

  it("collects only unique primitive annotations reachable through properties", () => {
    expect(collectMcpHeaderAnnotations(TOOL_SCHEMA)).toEqual([
      { name: "Region", path: ["region"], type: "string" },
      {
        name: "Retries",
        path: ["options", "retries"],
        type: "integer",
      },
      { name: "Active", path: ["options", "active"], type: "boolean" },
    ]);
    expect(collectMcpHeaderAnnotations({ type: "object" })).toEqual([]);
    expect(
      collectMcpHeaderAnnotations({ properties: { ignored: null } }),
    ).toEqual([]);
    expect(() => collectMcpHeaderAnnotations([])).toThrow(/tool schema/u);
    expect(() => collectMcpHeaderAnnotations({ properties: [] })).toThrow(
      /schema properties/u,
    );
    for (const property of [
      { type: "number", "x-mcp-header": "Number" },
      { type: "string", "x-mcp-header": "" },
      { type: "string", "x-mcp-header": "bad name" },
    ]) {
      expect(() =>
        collectMcpHeaderAnnotations({ properties: { value: property } }),
      ).toThrow(/x-mcp-header annotation/u);
    }
    expect(() =>
      collectMcpHeaderAnnotations({
        properties: {
          first: { type: "string", "x-mcp-header": "Region" },
          second: { type: "string", "x-mcp-header": "region" },
        },
      }),
    ).toThrow(/x-mcp-header annotation/u);
    expect(() =>
      collectMcpHeaderAnnotations({
        definitions: {
          hidden: { type: "string", "x-mcp-header": "Hidden" },
        },
      }),
    ).toThrow(/not statically reachable/u);
    for (const schema of [
      { items: { type: "string", "x-mcp-header": "Bad" } },
      {
        properties: {
          value: {
            type: "string",
            oneOf: [{ type: "string", "x-mcp-header": "Bad" }],
          },
        },
      },
    ]) {
      expect(() => collectMcpHeaderAnnotations(schema)).toThrow(
        /not statically reachable/u,
      );
    }
  });

  it("builds required standard and schema-derived request headers", () => {
    const request = modernRequest("tools/call", {
      name: "execute_sql",
      arguments: {
        region: "Hello, 世界",
        options: { retries: 2, active: false },
      },
    });
    expect(
      buildMcpHttpRequestHeaders({ request, toolSchema: TOOL_SCHEMA }),
    ).toEqual({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PM_MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "execute_sql",
      "Mcp-Param-Region": "=?base64?SGVsbG8sIOS4lueVjA==?=",
      "Mcp-Param-Retries": "2",
      "Mcp-Param-Active": "false",
    });
    expect(
      buildMcpHttpRequestHeaders({
        request: modernRequest("resources/read", { uri: "pm://space/世界" }),
      })["Mcp-Name"],
    ).toMatch(/^=\?base64\?/u);
    expect(
      buildMcpHttpRequestHeaders({ request: modernRequest("tools/list") }),
    ).not.toHaveProperty("Mcp-Name");
    expect(() =>
      buildMcpHttpRequestHeaders({ request: modernRequest("") }),
    ).toThrow(/request method/u);
    expect(() =>
      buildMcpHttpRequestHeaders({ request: modernRequest("prompts/get") }),
    ).toThrow(/request name/u);
    expect(() =>
      buildMcpHttpRequestHeaders({ request: { method: "tools/list" } }),
    ).toThrow(PmMcpProtocolError);
    expect(
      buildMcpHttpRequestHeaders({
        request: modernRequest("tools/call", { name: "execute_sql" }),
        toolSchema: TOOL_SCHEMA,
      }),
    ).not.toHaveProperty("Mcp-Param-Region");
    for (const argumentsValue of [
      { region: 7 },
      { options: { retries: 2.5 } },
      { options: { active: "true" } },
    ]) {
      expect(() =>
        buildMcpHttpRequestHeaders({
          request: modernRequest("tools/call", {
            name: "execute_sql",
            arguments: argumentsValue,
          }),
          toolSchema: TOOL_SCHEMA,
        }),
      ).toThrow(/custom header argument/u);
    }
  });

  it("validates standard and custom headers case-insensitively against the body", () => {
    const request = modernRequest("tools/call", {
      name: "execute_sql",
      arguments: { region: "us-west1", options: { retries: 42, active: true } },
    });
    const headers = buildMcpHttpRequestHeaders({
      request,
      toolSchema: TOOL_SCHEMA,
    });
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
        request,
        toolSchema: TOOL_SCHEMA,
      }),
    ).not.toThrow();
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: { ...headers, "Mcp-Param-Retries": "42.0" },
        request,
        toolSchema: TOOL_SCHEMA,
      }),
    ).not.toThrow();
    for (const broken of [
      { ...headers, "MCP-Protocol-Version": "2025-06-18" },
      { ...headers, "Mcp-Method": "tools/list" },
      { ...headers, "Mcp-Name": "other" },
      { ...headers, "Last-Event-ID": "7" },
      { ...headers, "Mcp-Param-Region": "elsewhere" },
      { ...headers, "Mcp-Param-Retries": "NaN" },
      { ...headers, "Mcp-Param-Active": "false" },
    ]) {
      expect(() =>
        validateMcpHttpRequestHeaders({
          headers: broken,
          request,
          toolSchema: TOOL_SCHEMA,
        }),
      ).toThrow(PmMcpProtocolError);
    }
    const { "Mcp-Param-Region": _region, ...withoutRegion } = headers;
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: withoutRegion,
        request,
        toolSchema: TOOL_SCHEMA,
      }),
    ).toThrow(/Missing MCP parameter/u);
    const nullRequest = modernRequest("tools/call", {
      name: "execute_sql",
      arguments: { region: null },
    });
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: {
          ...buildMcpHttpRequestHeaders({ request: nullRequest }),
          "Mcp-Param-Region": "unexpected",
        },
        request: nullRequest,
        toolSchema: TOOL_SCHEMA,
      }),
    ).toThrow(/Unexpected MCP parameter/u);
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: {
          ...headers,
          Ignored: undefined,
          "MCP-Protocol-Version": [PM_MCP_PROTOCOL_VERSION],
        },
        request,
        toolSchema: TOOL_SCHEMA,
      }),
    ).not.toThrow();
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: {},
        request: { method: "tools/list" },
      }),
    ).toThrow(PmMcpProtocolError);
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: {
          "MCP-Protocol-Version": PM_MCP_PROTOCOL_VERSION,
          "Mcp-Method": "",
        },
        request: { ...modernRequest("tools/list"), method: 7 },
      }),
    ).not.toThrow();
    expect(() =>
      validateMcpHttpRequestHeaders({
        headers: {
          ...buildMcpHttpRequestHeaders({
            request: modernRequest("tools/call", { name: "execute_sql" }),
          }),
        },
        request: modernRequest("tools/call", { name: "execute_sql" }),
        toolSchema: TOOL_SCHEMA,
      }),
    ).not.toThrow();
  });
});
