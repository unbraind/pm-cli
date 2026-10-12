# SDK Consumer Receipts

Trackers: [pm-i4kxx1](../.agents/pm/tasks/pm-i4kxx1.toon),
[pm-by83yj](../.agents/pm/issues/pm-by83yj.toon),
[pm-distribution-consumer-lease](../.agents/pm/issues/pm-distribution-consumer-lease.toon),
[pm-ty5i58](../.agents/pm/issues/pm-ty5i58.toon).

Project management is context management: consumers must distinguish useful
context from an omission and follow recoveries that the host can execute.

`PmClient` directly implements `ContextEvaluationReader`. Structural readers can
return their complete context or next packet plus universal read receipts.
`runContextEvaluationScenario` refuses a universal budget-exceeded result or a
whole-result omission in either `read_output` or `context_intent` before it
computes ranking metrics. This also covers an exhausted shared output session
when the individual read requests an unbounded budget. Reader refusals, including
a completely exhausted session, propagate with their original diagnosis. Retry with an adequate
budget or a fresh session. Ordinary bounded row selection is still evaluated;
complete packets retain token accounting and served-item attribution.

Core metadata is reserved from extension `--field` assignments. Create and
update recoveries resolve actual flags from the command registration contracts,
including aliases such as `--estimate` for `estimated_minutes`. Collection routes
reuse the same mapping as structured item IO, such as `comments` to `--comment`
and `type_options` to `--type-option`. Recovery names only declared mutation
routes and retains the other required-option policy. A stored
field does not imply a CLI flag. `external_ref` has no dedicated create/update
CLI mutation flag; its refusal says so and points to the owning lifecycle,
evidence, or importer API. Existing imported references remain readable and
preserved. Extension authors should register a distinct field for custom data.
The standalone SDK field parser also declines to invent host command flags.

Typed schema customization also preserves the declared storage type.
`PmClient.schemaAddField(name, { type: "number" })` and the functional
`schemaAddField` export translate the documented `type` option to the schema
action's `fieldType` input. Number and boolean registrations therefore retain
those persisted types and their coercion rules. An omitted type still defaults
to string. Generic `client.run("schema", ...)` consumers continue to use
`fieldType`. Installed Node and Bun acceptance exercises registration, reads the
persisted definitions, and creates typed custom values before evaluating context.
Schema-managed fields use their declared dynamic create/update options: for
example, `sdkNumeric: "7"` follows the generated `--sdk-numeric` option and stores
the number `7`. Inspect the schema and command contracts for those names.
Extension-registered fields use the separate `field` assignment collection.

Distribution packing acquires the same checkout lease as builds and tests before
reading manifests, inventorying source files, and staging the physical package.
It retains the lease until packing finishes. A nested packer can reuse the
consumer token only when its physical root matches the root named by the
inherited lease receipt and the live owner's receipt validates. Validation runners supply
`PM_BUILD_CONSUMER_LEASE_ROOT`; legacy tokens are scoped to the script workspace.
Linked commands cannot override lease controls through stored environment
directives. Snapshot and isolated execution clear both inherited lease variables,
keeping source ownership and its workspace path outside those child contexts.
Foreign workspaces acquire their own lease. An inherited owner path that no
longer resolves also takes this independent path; it never authorizes token reuse.
Interrupted builds retain an incomplete
marker and are refused until a complete rebuild succeeds. Packing never steals
a lease by age or removes another owner's receipt. Source-path checks, exact
runtime-ledger verification, and lossless metadata staging remain enforced.

`packDistribution` is an asynchronous repository helper; callers await its
receipt. The CLI entrypoint also awaits it before reporting an artifact. The
independent-process regression starts the real build entrypoint with owned
fixture build stages, verifies contention against the producer's live receipt,
and compares both archive files with the completed generation. Timing alone is
not the overlap oracle.
