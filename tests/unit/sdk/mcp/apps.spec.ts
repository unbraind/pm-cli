import { describe, expect, it } from "vitest";
import {
  PM_MCP_APPS_EXTENSION,
  PM_MCP_APPS_SERVER_CAPABILITY,
  PM_MCP_APPS_SPEC_VERSION,
  PM_MCP_APP_CONTRACTS,
  PM_MCP_APP_MIME_TYPE,
  PM_MCP_META_KEYS,
  PM_MCP_PROTOCOL_VERSION,
  PmMcpProtocolError,
  decoratePmMcpToolsWithApps,
  findPmMcpAppByUri,
  hasPmMcpAppsCapability,
  renderPmMcpAppHtml,
  resolveMcpRequestContext,
} from "../../../../src/sdk/index.js";

function context(extension: unknown) {
  return resolveMcpRequestContext({
    _meta: {
      [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
      [PM_MCP_META_KEYS.clientCapabilities]:
        extension === undefined
          ? {}
          : { extensions: { [PM_MCP_APPS_EXTENSION]: extension } },
    },
  });
}

describe("MCP Apps SDK contracts", () => {
  it("publishes the stable extension, MIME type, and five authoritative views", () => {
    expect(PM_MCP_APPS_EXTENSION).toBe("io.modelcontextprotocol/ui");
    expect(PM_MCP_APPS_SPEC_VERSION).toBe("2026-01-26");
    expect(PM_MCP_APP_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(PM_MCP_APPS_SERVER_CAPABILITY).toEqual({
      specVersion: "2026-01-26",
      mimeTypes: ["text/html;profile=mcp-app"],
    });
    expect(PM_MCP_APP_CONTRACTS.map(({ id, toolName }) => [id, toolName])).toEqual([
      ["context", "pm_context"],
      ["graph", "pm_graph"],
      ["plan", "pm_plan"],
      ["assurance", "pm_validate"],
      ["operations", "pm_test"],
    ]);
    expect(PM_MCP_APP_CONTRACTS.every(({ resourceMeta }) =>
      resourceMeta.csp?.connectDomains?.length === 0 &&
      resourceMeta.csp?.resourceDomains?.length === 0,
    )).toBe(true);
  });

  it("negotiates only compatible explicit client capabilities", () => {
    expect(hasPmMcpAppsCapability(context(undefined))).toBe(false);
    expect(
      hasPmMcpAppsCapability(
        resolveMcpRequestContext({
          _meta: {
            [PM_MCP_META_KEYS.protocolVersion]: PM_MCP_PROTOCOL_VERSION,
            [PM_MCP_META_KEYS.clientCapabilities]: { extensions: {} },
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasPmMcpAppsCapability(
        context({ mimeTypes: [PM_MCP_APP_MIME_TYPE] }),
      ),
    ).toBe(true);
    expect(
      hasPmMcpAppsCapability(
        context({ ...PM_MCP_APPS_SERVER_CAPABILITY }),
      ),
    ).toBe(true);
    for (const capability of [null, {}, { mimeTypes: [] }, {
      mimeTypes: [PM_MCP_APP_MIME_TYPE],
      specVersion: "1900-01-01",
    }]) {
      expect(() => hasPmMcpAppsCapability(context(capability))).toThrow(
        PmMcpProtocolError,
      );
    }
  });

  it("decorates only matching tools without mutating caller definitions", () => {
    const tools = [
      { name: "pm_context", inputSchema: {}, _meta: { owner: "pm" } },
      { name: "pm_create", inputSchema: {} },
    ];
    const decorated = decoratePmMcpToolsWithApps(tools);
    expect(decorated[0]._meta).toEqual({
      owner: "pm",
      ui: {
        resourceUri: "ui://pm/context.html",
        visibility: ["model", "app"],
      },
    });
    expect(decorated[1]).toEqual(tools[1]);
    expect(tools[0]._meta).toEqual({ owner: "pm" });
  });

  it("renders self-contained accessible views with bounded evidence and no network policy", () => {
    const contract = PM_MCP_APP_CONTRACTS[0];
    expect(findPmMcpAppByUri(contract.uri)).toBe(contract);
    expect(findPmMcpAppByUri("ui://pm/missing.html")).toBeUndefined();
    const html = renderPmMcpAppHtml({
      ...contract,
      name: '<Context & "proof">',
      description: "Evidence's view",
    });
    expect(html).toContain("&lt;Context &amp; &quot;proof&quot;&gt;");
    expect(html).toContain("Evidence&#39;s view");
    expect(html).toContain('request("ui/initialize"');
    expect(html).toContain('method:"ui/notifications/initialized"');
    expect(html).toContain("ui/notifications/tool-result");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("View truncated at");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("localStorage");
  });
});
