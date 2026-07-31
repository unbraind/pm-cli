# SDK Lifecycle Policy

Tracked by [pm-z5pmf8](../.agents/pm/issues/pm-z5pmf8.toon),
[pm-xm0id4](../.agents/pm/issues/pm-xm0id4.toon), and
[pm-2ew0w3](../.agents/pm/issues/pm-2ew0w3.toon).

The public SDK owns terminal-transition policy. CLI and MCP close operations
delegate to the same SDK implementation, so an item does not gain different
governance or graph semantics depending on the presentation surface that
invoked it.

## Reason Contract

`resolveTerminalReason` is the pure precedence primitive. It chooses the first
non-blank author-controlled value in this order:

1. explicit reason;
2. duplicate target (`Duplicate of <id>`);
3. structured resolution;
4. history message.

`requireTerminalReason` adds governance. When a reason is required and no
author-controlled source exists, it throws `close_reason_required`. It never
invents a placeholder for immutable history. Direct `close`,
`update --status <terminal>`, and direct terminal `create` therefore share the
same refusal contract.

## Ordering Contract

The default `orderingEdges: "preserve"` policy clears transient
`blocked_by`/`blocked_reason` scalars when an item closes but retains
`dependencies[].kind = "blocked_by"` rows. Those rows are predecessor facts:
they remain useful to historical graph traversal, planning analytics, and
context reconstruction after both endpoints are terminal.

An embedded SDK consumer can explicitly choose `orderingEdges: "remove"` for
a domain where predecessor facts are intentionally ephemeral. The CLI and MCP
do not expose that override and use the durable default.

```ts
import {
  closeItem,
  requireTerminalReason,
  type TerminalTransitionPolicy,
} from "@unbrained/pm-cli/sdk";

const policy: TerminalTransitionPolicy = {
  requireCloseReason: true,
  orderingEdges: "preserve",
};

const reason = requireTerminalReason(
  { resolution: "Acceptance suite and package-consumer proof passed." },
  policy.requireCloseReason,
);

await closeItem(
  "pm-example",
  reason.closeReason,
  { lifecyclePolicy: policy },
  { path: "/project/.agents/pm" },
);
```

The compilable example lives at
[`examples/sdk-lifecycle-policy/index.ts`](examples/sdk-lifecycle-policy/index.ts).

## Compatibility

`runClose`, `CloseCommandOptions`, and `CloseResult` remain supported aliases.
New integrations should prefer `closeItem`, `CloseOperationOptions`, and
`CloseOperationResult`; the operation vocabulary remains meaningful outside a
command-line host.
