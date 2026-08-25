# MCP Interaction and Task SDK

Tracker references: [pm-rz9gep](../.agents/pm/features/pm-rz9gep.toon),
[pm-rzs24j](../.agents/pm/features/pm-rzs24j.toon), and
[pm-hv1x1x](../.agents/pm/features/pm-hv1x1x.toon).

The aggregate `@unbrained/pm-cli/sdk` entrypoint exposes transport-neutral
contracts for MCP 2026-07-28 multi round-trip requests (MRTR), explicit cache
policy, bounded JSON Schema 2020-12 validation, and the official durable tasks
extension. A custom stdio or HTTP host can reuse these primitives without
importing pm's executable server.

## Request more host input

Throw `PmMcpInputRequiredError` from domain code. The host adapter converts the
signal into an `input_required` result after validating request method,
payload bounds, and the request-local client capability.

```ts
import {
  PmMcpInputRequiredError,
  digestMcpRequestParameters,
  sealMcpRequestState,
} from "@unbrained/pm-cli/sdk";

const requestState = sealMcpRequestState(
  {
    expiresAt: Date.now() + 5 * 60_000,
    method: "tools/call",
    parameterDigest: digestMcpRequestParameters({ name: "pm_mutate" }),
    principal: "host-user-42",
    state: { phase: "confirm" },
  },
  process.env.MCP_REQUEST_STATE_KEY!, // at least 32 bytes
);

throw new PmMcpInputRequiredError({
  requestState,
  inputRequests: {
    confirmation: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Apply the proposed PM mutations?",
        requestedSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
          required: ["approved"],
        },
      },
    },
  },
});
```

Use `openMcpRequestState()` on retry to verify signature, expiry, original
method, parameter digest, and principal. Call
`PmMcpRequestStateReplayGuard.consume()` only after successful verification.
The bundled guard provides bounded single-process replay detection; a
multi-process host should persist the consumed state digest in its shared
store. `parseMcpInputResponses()` validates and clones retry responses.

The permitted input request methods are
`elicitation/create`, `roots/list`, and `sampling/createMessage`. The client
must advertise the corresponding capability on that same request.

## Validate schemas and attach cache policy

`validateMcpJsonSchema()` accepts object and boolean JSON Schema 2020-12 roots,
resolves local JSON Pointer references, and applies byte, depth, and node work
bounds. It returns a clone so callers cannot mutate the validated input by
alias. External references remain identifiers; this validator does not perform
network retrieval.

```ts
import {
  validateMcpJsonSchema,
  withMcpCachePolicy,
} from "@unbrained/pm-cli/sdk";

const inputSchema = validateMcpJsonSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
});

const result = withMcpCachePolicy(
  { tools: [{ name: "get_item", inputSchema }] },
  { ttlMs: 30_000, cacheScope: "private" },
);
```

Use `cacheScope: "private"` whenever a result depends on a workspace,
principal, authorization decision, or user data. A `public` result must be
safe for shared intermediaries and all principals for its full TTL.

## Run durable extension tasks

`createMcpTaskStore()` persists task records below the supplied tracker root's
ignored `runtime/mcp-tasks` directory. It creates the durable record before
returning a handle and serializes mutations with pm's cross-process lock.

```ts
import { createMcpTaskStore } from "@unbrained/pm-cli/sdk";

const tasks = createMcpTaskStore({
  pmRoot: "/workspace/project/.agents/pm",
});

const handle = await tasks.create({
  principal: "host-user-42",
  ttlMs: 60 * 60_000,
  statusMessage: "Validating the workspace.",
});

try {
  const result = await validateWorkspace();
  await tasks.complete(handle.taskId, "host-user-42", result);
} catch (error) {
  await tasks.fail(handle.taskId, "host-user-42", {
    code: -32603,
    message: error instanceof Error ? error.message : "Validation failed",
  });
}
```

The lifecycle is `working` to `input_required`, `completed`, `failed`, or
`cancelled`. `get()` applies retention expiry and restart recovery;
`requireInput()` records MRTR requests; `update()` accepts matching responses;
`takeInputResponses()` transfers them to a resumed worker; and `cancel()` is a
cooperative state transition. Completed, failed, and cancelled records are
immutable. Task ids and principal mismatches intentionally return the same
not-found refusal to avoid disclosing another principal's work.

The bundled `pm-mcp` server negotiates the extension through
`io.modelcontextprotocol/tasks`. Eligible validation, health, graph, import,
reindex, and test operations may return a task handle when the client requests
asynchronous execution. Clients retrieve state with `tasks/get`, provide MRTR
answers with `tasks/update`, and request cancellation with `tasks/cancel`.

Task progress notifications and cross-transport request-scoped streams are a
separate subscription contract. A client must poll at `pollIntervalMs` until
that contract is advertised.

## Failure and trust boundaries

- Keep signing keys outside request data and logs; rotate them using a bounded
  overlap strategy owned by the host.
- Bind continuation state and tasks to an authenticated principal chosen by
  the host, never to a caller-supplied display name.
- Treat `ttlMs` as retention/freshness policy, not proof that underlying data
  is unchanged.
- A worker lost across process restart becomes a terminal, non-recoverable task
  result. Create a new task instead of replaying side effects implicitly.
- The task store is durable local coordination, not a distributed queue. A
  multi-host deployment should implement the same public lifecycle on a
  shared transactional backend.
