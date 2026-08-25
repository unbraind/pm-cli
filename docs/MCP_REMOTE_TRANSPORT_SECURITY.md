# MCP Remote Transport, Authorization, and Migration

Tracker references: [pm-v7e337](../.agents/pm/features/pm-v7e337.toon),
[pm-3zh9s4](../.agents/pm/features/pm-3zh9s4.toon), and
[pm-vzcisw](../.agents/pm/chores/pm-vzcisw.toon).

pm exposes the same MCP 2026-07-28 dispatcher through two adapters:

- `pm-mcp` is the local JSON-RPC/stdio process. It retains a bounded
  `2025-06-18` compatibility adapter for existing local consumers.
- `pm-mcp-http` is the canonical sessionless Streamable HTTP POST process. It
  accepts only modern request-local protocol metadata and never creates an
  MCP session.

The public `@unbrained/pm-cli/sdk` entrypoint owns subscription filtering,
HTTP header projection, authorization discovery and validation, issuer-keyed
credentials, bearer enforcement, and trace-context isolation. Adapters remain
thin bindings over those contracts.

## Run the HTTP adapter

The safe default binds only `127.0.0.1:3000`:

```bash
pm-mcp-http
```

Configuration is explicit and environment-only:

| Variable | Meaning | Default |
| --- | --- | --- |
| `PM_MCP_HTTP_HOST` | Bind host | `127.0.0.1` |
| `PM_MCP_HTTP_PORT` | Bind port, including `0` for an ephemeral test port | `3000` |
| `PM_MCP_HTTP_ALLOWED_ORIGINS` | Comma-separated exact browser origins | none |
| `PM_MCP_HTTP_BEARER_TOKEN` | Opaque deployment token for the bundled verifier | none |
| `PM_MCP_HTTP_AUTH_ISSUER` | Exact HTTPS authorization-server issuer | none |
| `PM_MCP_HTTP_RESOURCE` | Canonical MCP resource/audience URI | none |
| `PM_MCP_HTTP_SCOPES` | Space-separated consent scopes | `pm:read pm:write` |

A non-loopback bind fails closed unless token, issuer, and resource are all
present. Production deployments should normally call
`createPmMcpHttpServer()` with an OAuth access-token verifier backed by their
authorization server instead of using the executable's single opaque-token
bootstrap verifier.

For example, this starts a deliberately local protected endpoint without
placing a real credential in documentation:

```bash
PM_MCP_HTTP_BEARER_TOKEN='<deployment-secret>' \
PM_MCP_HTTP_AUTH_ISSUER='https://auth.example.test' \
PM_MCP_HTTP_RESOURCE='http://127.0.0.1:3000/mcp' \
pm-mcp-http
```

The adapter serves RFC 9728 protected-resource metadata at both
`/.well-known/oauth-protected-resource` and the path-qualified
`/.well-known/oauth-protected-resource/mcp` location.

## Stream and header contract

Every HTTP request is a POST to `/mcp` and negotiates both
`application/json` and `text/event-stream`. Normal finite requests return
JSON. `subscriptions/listen` returns an SSE response whose first message is
`notifications/subscriptions/acknowledged`; every later subscription
notification carries the listen request's JSON-RPC id in
`io.modelcontextprotocol/subscriptionId`.

The supported opt-ins are tool-list, prompt-list, resource-list, and exact
resource-update notifications. Writes await the transport sink, so a slow
consumer applies backpressure rather than reordering messages. Disconnecting
deletes the request-scoped subscription. A broken stream has no replay cursor:
there are no SSE event ids and `Last-Event-ID` is rejected. The caller retries
the lost operation with a new JSON-RPC request id.

`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` are built and validated
against the JSON-RPC body. Tool properties may declare `x-mcp-header` in their
JSON Schema; the SDK validates the header name, rejects reserved or duplicate
mappings, encodes non-ASCII and ambiguous values with the MCP Base64 sentinel,
and compares the decoded header with the argument value before dispatch.
CR/LF and control-character values are always rejected.

Current pm handlers do not emit request progress or deprecated MCP log-message
notifications. A `progressToken` or request-local
`io.modelcontextprotocol/logLevel` is therefore never promoted to a shared
subscription. Work that returns a durable task remains observable through the
task lifecycle; remote operational logging belongs in the deployment's
OpenTelemetry pipeline.

## Authorization lifecycle

Remote hosts can compose the public SDK primitives into a complete OAuth
client/resource lifecycle:

1. Build or read protected-resource metadata and choose an advertised
   authorization-server issuer.
2. Probe OAuth and OpenID discovery URLs in the specified order. Require the
   metadata `issuer` to match exactly and require S256 PKCE.
3. Prefer a pre-registered client, then a validated Client ID Metadata
   Document, then bounded Dynamic Client Registration, and finally explicit
   user-supplied registration.
4. Validate a returned `iss` when present or advertised, bind stored
   credentials to the exact issuer, and never reuse them across issuers.
5. Request only the scopes needed for the operation. The resource verifies
   bearer location, issuer, audience, and every required consent scope before
   MCP dispatch.
6. Replace an issuer's stored credential after refresh. Delete only that
   issuer's entry on revocation, invalid grant, or re-registration; discovery
   and consent then run again without affecting other issuers.

`PmMcpIssuerCredentialStore` deliberately provides cloned `set`, `get`, and
`delete` operations rather than owning token refresh network traffic. This
keeps refresh, revocation, persistence encryption, and user interaction in the
host that owns the authorization relationship.

## Trace and privacy boundary

Modern request `_meta` may carry W3C `traceparent`, `tracestate`, and baggage.
The SDK validates syntax and byte bounds, drops every baggage member that is
not on the host-provided allowlist, and stores the resulting context in an
`AsyncLocalStorage` scope for only that request. Concurrent requests cannot
inherit one another's trace context. Raw bearer tokens are hashed for
constant-time comparison by the bundled verifier and are never included in
claims, errors, traces, or JSON-RPC result data.

| Threat | Enforced boundary |
| --- | --- |
| DNS rebinding/browser drive-by | Loopback default plus exact `Origin` allowlist |
| Token passthrough | Bearer is verified at pm and never forwarded to another service |
| Issuer mix-up | Exact discovery/response issuer checks and issuer-keyed credentials |
| Confused audience | Exact protected-resource audience check |
| Excess authority | Required-scope intersection before dispatch |
| Query/log credential leak | Query tokens rejected; challenges and errors omit token material |
| Header injection | Schema-derived allowlist, reserved-name checks, control-byte rejection |
| Trace privacy leak | Syntax/size validation, baggage-key allowlist, request-local storage |
| Proxy cache disclosure | MCP and metadata errors use explicit content types; MCP results use `no-store` |
| Replay after disconnect | No session, event id, resume cursor, or redelivery; retry uses a new request id |

## Deprecated-feature inventory and sunset

Run the generated ratchet locally or in CI:

```bash
pnpm quality:mcp-deprecations
```

The inventory classifies every match as canonical source, the isolated legacy
adapter, migration documentation, or a negative control. Any canonical match
for a removed method, session header, SSE resume mechanism, legacy
resource-subscription method, or deprecated server policy fails the gate.

The compatibility adapter supports only protocol `2025-06-18` on local stdio.
It may be removed after telemetry and installed-consumer probes show no
required legacy clients for two consecutive release windows. Deprecated
2026-07-28 fields remain available only where the normative registry requires
its minimum compatibility period; no pm sunset occurs earlier than
2027-07-28. A removal is always a reviewed release change with packed and
published consumer proof.

## Verification

Focused release evidence is reproducible with:

```bash
node scripts/run-tests.mjs test -- tests/unit/sdk/mcp/subscriptions.spec.ts
node scripts/run-tests.mjs test -- tests/unit/sdk/mcp/transport.spec.ts
node scripts/run-tests.mjs test -- tests/unit/sdk/mcp/authorization.spec.ts
node scripts/run-tests.mjs test -- tests/integration/mcp-streamable-http.spec.ts
node scripts/run-tests.mjs test -- tests/unit/scripts/release/mcp-deprecation-gate.spec.ts
pnpm quality:mcp-deprecations
```

The full release gates, packed artifact probes, installed `npx`/`bunx`
consumers, and published artifact checks remain distinct closeout evidence.
