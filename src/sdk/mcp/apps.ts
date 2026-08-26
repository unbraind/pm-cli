/**
 * @module sdk/mcp/apps
 *
 * Defines the optional MCP Apps extension surface for pm. The SDK owns the
 * protocol metadata and self-contained views; transports only negotiate and
 * project these contracts.
 */
import type {
  McpUiAppResourceConfig as OfficialMcpUiAppResourceConfig,
  McpUiAppToolConfig as OfficialMcpUiAppToolConfig,
} from "@modelcontextprotocol/ext-apps/server";
import {
  PM_MCP_ERROR_CODES,
  PmMcpProtocolError,
  isMcpRecord,
  type PmMcpRequestContext,
} from "./protocol.js";

type OfficialMcpUiResourceMeta = NonNullable<
  NonNullable<OfficialMcpUiAppResourceConfig["_meta"]>["ui"]
>;
type OfficialMcpUiToolMeta = Extract<
  OfficialMcpUiAppToolConfig["_meta"],
  { ui: unknown }
>["ui"];

interface McpUiToolMeta {
  /** MCP App resource displayed for this tool. */
  resourceUri: string;
  /** Principals allowed to discover and invoke the tool. */
  visibility: Array<"model" | "app">;
}

interface McpUiResourceMeta {
  /** Explicitly bounded network and embedding policy. */
  csp: {
    connectDomains: string[];
    resourceDomains: string[];
    frameDomains: string[];
  };
  /** Browser permissions requested by the app. */
  permissions: Record<string, never>;
  /** Whether the host should present a visible app boundary. */
  prefersBorder: boolean;
}

/** Stable MCP Apps extension identifier. */
export const PM_MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui" as const;

/** Stable MCP Apps specification revision implemented by pm. */
export const PM_MCP_APPS_SPEC_VERSION = "2026-01-26" as const;

/** Official MIME type for MCP App HTML resources. */
export const PM_MCP_APP_MIME_TYPE = "text/html;profile=mcp-app" as const;

/** Server-side MCP Apps capability advertised through discovery. */
export const PM_MCP_APPS_SERVER_CAPABILITY = Object.freeze({
  specVersion: PM_MCP_APPS_SPEC_VERSION,
  mimeTypes: [PM_MCP_APP_MIME_TYPE],
});

/**
 * Resolve whether a request negotiated MCP Apps, rejecting malformed explicit
 * declarations instead of silently serving a different extension revision.
 */
export function hasPmMcpAppsCapability(context: PmMcpRequestContext): boolean {
  const extensions = context.clientCapabilities.extensions;
  if (!isMcpRecord(extensions)) return false;
  const declaration = extensions[PM_MCP_APPS_EXTENSION];
  if (declaration === undefined) return false;
  if (!isMcpRecord(declaration)) {
    throw new PmMcpProtocolError(
      "Invalid MCP Apps client capability",
      PM_MCP_ERROR_CODES.missingRequiredClientCapability,
      { requiredCapabilities: { extensions: { [PM_MCP_APPS_EXTENSION]: PM_MCP_APPS_SERVER_CAPABILITY } } },
    );
  }
  const mimeTypes = declaration.mimeTypes;
  const specVersion = declaration.specVersion;
  if (
    !Array.isArray(mimeTypes) ||
    !mimeTypes.includes(PM_MCP_APP_MIME_TYPE) ||
    (specVersion !== undefined && specVersion !== PM_MCP_APPS_SPEC_VERSION)
  ) {
    throw new PmMcpProtocolError(
      "Unsupported MCP Apps client capability",
      PM_MCP_ERROR_CODES.missingRequiredClientCapability,
      { requiredCapabilities: { extensions: { [PM_MCP_APPS_EXTENSION]: PM_MCP_APPS_SERVER_CAPABILITY } } },
    );
  }
  return true;
}

/** One optional pm view and the authoritative tool that supplies its data. */
export interface PmMcpAppContract {
  /** Stable view identifier. */
  id: "context" | "graph" | "plan" | "assurance" | "operations";
  /** Human-readable view name. */
  name: string;
  /** Concise purpose shown during resource discovery. */
  description: string;
  /** Existing SDK-backed tool whose result the view renders. */
  toolName: string;
  /** Stable MCP App resource URI. */
  uri: string;
  /** Tool metadata validated against the official MCP Apps package types. */
  toolMeta: McpUiToolMeta;
  /** Resource sandbox and presentation metadata. */
  resourceMeta: McpUiResourceMeta;
}

const PRIVATE_APP_RESOURCE_META: McpUiResourceMeta = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
  permissions: {},
  prefersBorder: true,
} satisfies OfficialMcpUiResourceMeta;

/** Canonical optional pm MCP Apps. */
export const PM_MCP_APP_CONTRACTS: readonly PmMcpAppContract[] = Object.freeze(
  ([
    {
      id: "context",
      name: "Context explorer",
      description:
        "Inspect bounded project context, provenance, omissions, and token accounting.",
      toolName: "pm_context",
      uri: "ui://pm/context.html",
    },
    {
      id: "graph",
      name: "Relationship graph",
      description:
        "Explore typed relationships, explaining paths, and graph-governance evidence.",
      toolName: "pm_graph",
      uri: "ui://pm/graph.html",
    },
    {
      id: "plan",
      name: "Plan and milestone view",
      description:
        "Review durable plan steps, dependencies, decisions, discoveries, and validation state.",
      toolName: "pm_plan",
      uri: "ui://pm/plan.html",
    },
    {
      id: "assurance",
      name: "Assurance dashboard",
      description:
        "Inspect validation verdicts, evidence, omissions, and actionable recovery paths.",
      toolName: "pm_validate",
      uri: "ui://pm/assurance.html",
    },
    {
      id: "operations",
      name: "Long-operation view",
      description:
        "Inspect durable test and operation results without creating a second task store.",
      toolName: "pm_test",
      uri: "ui://pm/operations.html",
    },
  ] satisfies readonly Omit<PmMcpAppContract, "toolMeta" | "resourceMeta">[]).map((contract) => ({
    ...contract,
    toolMeta: {
      resourceUri: contract.uri,
      visibility: ["model", "app"],
    } satisfies OfficialMcpUiToolMeta,
    resourceMeta: PRIVATE_APP_RESOURCE_META,
  })) as PmMcpAppContract[],
);

/** Return the app contract for a resource URI. */
export function findPmMcpAppByUri(
  uri: string,
): PmMcpAppContract | undefined {
  return PM_MCP_APP_CONTRACTS.find((contract) => contract.uri === uri);
}

/** Attach negotiated MCP App metadata to matching tool definitions. */
export function decoratePmMcpToolsWithApps<
  Tool extends { name: string; _meta?: Record<string, unknown> },
>(tools: readonly Tool[]): Tool[] {
  const appsByTool = new Map(
    PM_MCP_APP_CONTRACTS.map((contract) => [contract.toolName, contract]),
  );
  return tools.map((tool) => {
    const app = appsByTool.get(tool.name);
    return app
      ? {
          ...tool,
          _meta: { ...tool._meta, ui: app.toolMeta },
        }
      : { ...tool };
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render a self-contained, sandbox-compatible MCP App document.
 *
 * The view keeps no durable state and exposes no mutation control. It receives
 * the authoritative tool input/result from the host, bounds large rendering,
 * and presents the text fallback when structured content is unavailable.
 */
export function renderPmMcpAppHtml(contract: PmMcpAppContract): string {
  const title = escapeHtml(contract.name);
  const description = escapeHtml(contract.description);
  const appInfo = JSON.stringify({
    name: `pm-${contract.id}-view`,
    version: PM_MCP_APPS_SPEC_VERSION,
  });
  const protocolVersion = JSON.stringify(PM_MCP_APPS_SPEC_VERSION);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    :root{color-scheme:light dark;--ink:#172554;--muted:#526078;--panel:#f8fafc;--line:#cbd5e1;--signal:#0f766e;--accent:#4338ca;--danger:#b91c1c;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    @media(prefers-color-scheme:dark){:root{--ink:#e0e7ff;--muted:#a8b3c7;--panel:#111827;--line:#334155;--signal:#5eead4;--accent:#a5b4fc;--danger:#fca5a5}}
    *{box-sizing:border-box}body{margin:0;background:var(--panel);color:var(--ink)}main{display:grid;gap:1rem;padding:clamp(.9rem,3vw,1.5rem);max-width:76rem;margin:auto}header{display:grid;gap:.35rem;border-bottom:1px solid var(--line);padding-bottom:.8rem}h1{font-size:clamp(1.2rem,3vw,1.75rem);line-height:1.1;margin:0;letter-spacing:-.02em}p{margin:0;color:var(--muted);line-height:1.5}.status{display:flex;align-items:center;gap:.5rem;font:600 .75rem ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}.status::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:var(--signal)}section{border:1px solid var(--line);border-radius:.8rem;padding:1rem;background:color-mix(in srgb,var(--panel) 92%,var(--accent) 8%)}h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;margin:0 0 .7rem;color:var(--accent)}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:34rem;overflow:auto;margin:0;font:500 .78rem/1.55 ui-monospace,SFMono-Regular,monospace;tab-size:2}button{justify-self:start;border:1px solid var(--accent);border-radius:.45rem;background:transparent;color:var(--accent);padding:.55rem .75rem;font:600 .78rem inherit;cursor:pointer}button:focus-visible{outline:3px solid var(--signal);outline-offset:2px}.notice{color:var(--danger)}@media(max-width:40rem){main{padding:.75rem}section{padding:.8rem}pre{max-height:24rem}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
  </style>
</head>
<body>
<main>
  <header><div class="status" id="status" role="status" aria-live="polite">Connecting to host</div><h1>${title}</h1><p>${description}</p></header>
  <section aria-labelledby="summary-title"><h2 id="summary-title">Authoritative result</h2><pre id="result" tabindex="0">Waiting for the host tool result…</pre></section>
  <section aria-labelledby="input-title"><h2 id="input-title">Invocation context</h2><pre id="input" tabindex="0">No tool input received.</pre></section>
  <button type="button" id="copy">Copy visible evidence</button>
</main>
<script>
(()=>{"use strict";const MAX=24000,status=document.querySelector("#status"),result=document.querySelector("#result"),input=document.querySelector("#input"),pending=new Map();let nextId=1;const render=(node,value)=>{let text;try{text=typeof value==="string"?value:JSON.stringify(value,null,2)}catch{text="Result could not be serialized."}if(text.length>MAX)text=text.slice(0,MAX)+"\\n\\n[View truncated at "+MAX+" characters; use the authoritative pm tool with a cursor or narrower projection.]";node.textContent=text};const send=(message)=>window.parent.postMessage(message,"*");window.addEventListener("message",event=>{if(event.source!==window.parent||!event.data||event.data.jsonrpc!=="2.0")return;const message=event.data;if(message.id!==undefined&&pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);return}if(message.method==="ui/notifications/tool-input"||message.method==="ui/notifications/tool-input-partial"){render(input,message.params?.arguments??message.params);status.textContent="Input received"}else if(message.method==="ui/notifications/tool-result"){render(result,message.params);status.textContent="Current tool result"}else if(message.method==="ui/notifications/tool-cancelled"){status.textContent="Tool call cancelled";status.classList.add("notice")}else if(message.method==="ui/notifications/host-context-changed"&&message.params?.theme){document.documentElement.style.colorScheme=message.params.theme}});const request=(method,params)=>new Promise(resolve=>{const id=nextId++;pending.set(id,resolve);send({jsonrpc:"2.0",id,method,params})});document.querySelector("#copy").addEventListener("click",async()=>{const text=result.textContent+"\\n\\n"+input.textContent;try{await navigator.clipboard.writeText(text);status.textContent="Visible evidence copied"}catch{status.textContent="Clipboard permission unavailable";status.classList.add("notice")}});request("ui/initialize",{appInfo:${appInfo},appCapabilities:{},protocolVersion:${protocolVersion}}).then(message=>{if(message.error){status.textContent="Host rejected MCP App initialization";status.classList.add("notice");return}send({jsonrpc:"2.0",method:"ui/notifications/initialized"});status.textContent="Connected — awaiting authoritative result"})})();
</script>
</body>
</html>`;
}
