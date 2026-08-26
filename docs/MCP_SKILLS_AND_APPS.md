# MCP Skills and Apps

Tracker references: [pm-8nzivt](../.agents/pm/features/pm-8nzivt.toon),
[pm-pznhee](../.agents/pm/features/pm-pznhee.toon), and
[pm-55yf1t](../.agents/pm/tasks/pm-55yf1t.toon).

pm exposes optional workflow guidance and interactive context views without
moving authority out of the public SDK or the tracker. Both extensions require
explicit request-local negotiation. Clients that do not negotiate them retain
the complete CLI, SDK, tool, prompt, and ordinary resource behavior.

## Skills over MCP

Skills support follows the current SEP-2640 draft at the exact revision
`a3e147ca2710f68214247aecc729731ee1ae8d03`. Because the proposal is not a
stable MCP extension, discovery advertises both `status: draft` and that exact
revision. Every `skills/list`, `skills/get`, skill `resources/read`, and
`resources/directory/read` request must independently declare:

```json
{
  "extensions": {
    "io.modelcontextprotocol/skills": {
      "revision": "SEP-2640@a3e147ca2710f68214247aecc729731ee1ae8d03",
      "directoryRead": true
    }
  }
}
```

`skills/list` is lexically ordered and cursor-paginated. Descriptors contain
the parsed SKILL.md frontmatter, every file URI, byte size, SHA-256 digest,
estimated token cost, package/MCP compatibility, origin, and an explicit
`untrusted` trust marker. `skills/get` returns one descriptor without loading
file bodies. Digests use the draft's `sha256:<hex>` representation.
`resources/read` fetches one digest-bound file; the optional, cursor-paginated
directory read returns one directory's direct child resource metadata only.
Clients read selected file bodies through ordinary `resources/read` calls.

The published package carries the four canonical pm skills. A repository may
override a package skill by placing the same validated name below
`.agents/skills`, and the returned origin changes to `workspace`. Overrides do
not inherit trust: skill text is guidance, never implicit permission to execute
commands or mutate the tracker.

Security limits reject symbolic links, malformed or aliased YAML, mismatched
directory/frontmatter names, stale cursors, oversized files, excessive file
counts, and aggregate skill bodies above the declared bound. In accordance with
the draft, pm accepts at most 512 resources and 16 MiB of total content per
skill; the same 16 MiB ceiling applies to an individual resource. Each read is
resolved from the immutable in-memory registry used to compute its digest.

## MCP Apps

pm implements the stable MCP Apps `2026-01-26` extension through the official
`@modelcontextprotocol/ext-apps` metadata contracts. A client opts in with:

```json
{
  "extensions": {
    "io.modelcontextprotocol/ui": {
      "specVersion": "2026-01-26",
      "mimeTypes": ["text/html;profile=mcp-app"]
    }
  }
}
```

Negotiated `tools/list` attaches `_meta.ui.resourceUri` to five existing,
SDK-backed tools. `resources/list` and `resources/read` expose the corresponding
`ui://` documents:

| View | Authoritative tool | Purpose |
| --- | --- | --- |
| Context explorer | `pm_context` | Context, provenance, omissions, and token cost |
| Relationship graph | `pm_graph` | Typed edges, explaining paths, and governance |
| Plan and milestone | `pm_plan` | Steps, dependencies, decisions, and validation |
| Assurance dashboard | `pm_validate` | Verdicts, evidence, and recovery paths |
| Long-operation view | `pm_test` | Durable test and operation results |

Every view is self-contained and requests no network, storage, camera,
microphone, or location permission. It performs the MCP Apps initialization
handshake, listens for tool input/result/cancellation and host-context events,
bounds large renderings with an explicit truncation message, and retains the
tool result's text fallback. Layout is responsive, keyboard focus is visible,
and reduced-motion preferences are honored.

Apps keep no durable project state and expose no hidden mutation path. The
tracker, task store, mutation guards, consent, idempotency, and immutable
receipts remain owned by existing SDK-backed MCP tools. A host that cannot or
does not render Apps still receives meaningful tool text and structured data.

## Public SDK

Use `PmMcpSkillRegistry`, `assertPmMcpSkillsCapability()`,
`PM_MCP_SKILLS_SERVER_CAPABILITY`, `PM_MCP_APP_CONTRACTS`,
`hasPmMcpAppsCapability()`, `decoratePmMcpToolsWithApps()`, and
`renderPmMcpAppHtml()` from `@unbrained/pm-cli/sdk`. The server is a thin
adapter over these contracts; custom hosts can project the same resources and
security policy without importing pm server internals.
