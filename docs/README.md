# pm-cli Documentation

This directory is the public documentation home for `pm-cli`. It is organized for progressive disclosure: read the smallest page that answers the current question, then follow links only when more detail is needed.

## Optional CLI Guide Router

`pm guide` is provided by the optional `guide-shell` package. Install it when local in-CLI documentation routing is useful:

```bash
pm install guide-shell --project
pm guide
pm guide quickstart
pm guide commands --depth standard
pm guide sdk --depth deep --format markdown
pm guide release --json
```

## Read Path

| Reader                              | First page                                  | Then read                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New user                            | [Quickstart](QUICKSTART.md)                 | [Command Reference](COMMANDS.md)                                                                                                                               |
| New maintainer                      | [Onboarding](ONBOARDING.md)                 | [Agent Guide](AGENT_GUIDE.md), [Testing](TESTING.md), [Releasing](RELEASING.md)                                                                                |
| Coding agent                        | [Agent Guide](AGENT_GUIDE.md)               | [Configuration](CONFIGURATION.md), then command help                                                                                                           |
| Maintainer                          | [Contributing](../CONTRIBUTING.md)          | [Testing](TESTING.md), [Releasing](RELEASING.md), [Architecture](ARCHITECTURE.md)                                                                              |
| Package author                      | [Packages and Extensions](EXTENSIONS.md)    | [SDK](SDK.md), [starter extension](examples/starter-extension/README.md)                                                                                       |
| Codex or ChatGPT plugin implementer | [Codex Plugin](CODEX_PLUGIN.md)             | [Native ChatGPT and Codex Plugin Implementation Plan](CHATGPT_CODEX_PLUGIN_IMPLEMENTATION.md)                                                                  |
| Codex user                          | [Codex Plugin](CODEX_PLUGIN.md)             | [Agent Guide](AGENT_GUIDE.md), then [Command Reference](COMMANDS.md)                                                                                           |
| Claude Code user                    | [Claude Code Plugin](CLAUDE_CODE_PLUGIN.md) | [Agent Guide](AGENT_GUIDE.md), then [Command Reference](COMMANDS.md)                                                                                           |
| Machine client                      | `pm contracts --json`                       | [CLI Scripting Contract](SCRIPTING.md), [Command Reference](COMMANDS.md#machine-contracts), optionally `pm install guide-shell --project && pm guide commands` |

## Documentation Map

- [Quickstart](QUICKSTART.md) - install, initialize, create, claim, link, test, close.
- [Onboarding](ONBOARDING.md) - first-two-hours maintainer and contributor setup.
- [Agent Guide](AGENT_GUIDE.md) - canonical agent loop, tracker linking, and token-minimal command choices.
- [Command Reference](COMMANDS.md) - command families with examples and when to use each family.
- [CLI Scripting Contract](SCRIPTING.md) - exit codes, flat mutation receipts versus read envelopes, stdout/stderr boundaries, stable JSON fields, uniform OR filters, and shell composition recipes.
- [Configuration](CONFIGURATION.md) - settings, storage formats, output, search, validation, and environment variables.
- [Testing](TESTING.md) - sandbox-safe local tests and linked-test orchestration.
- [Security Governance](SECURITY_GOVERNANCE.md) - vulnerability reporting, review discipline, property fuzzing, and OpenSSF limitations.
- [Architecture](ARCHITECTURE.md) - contributor internals: storage, mutation flow, search, extensions, and command contracts.
- [SDK Primitive Inventory](SDK_PRIMITIVE_INVENTORY.md) - SDK-first migration map and private-import ratchet for CLI/MCP layering.
- [Package SDK Contract Conformance](PACKAGE_SDK_CONTRACT_CONFORMANCE.md) - authoritative public types, `typeof` module derivation, and the first-party parity gate.
- [SDK Action and Boundary Conformance](SDK_ACTION_CONFORMANCE.md) - derived CLI/SDK/MCP action vocabulary, public-import ratchets, intent budget diagnostics, and package-runner proof.
- [Context Relevance and Packing](CONTEXT_RELEVANCE.md) - shared CLI/SDK signals, derived-store provenance, ranking explanations, and token budgets.
- [Output Projection and Omission Contracts](OUTPUT_PROJECTION_CONTRACTS.md) - explicit withheld-field receipts, mode-paired row keys, and completion resolver outcomes.
- [Output Token Accounting](OUTPUT_TOKEN_ACCOUNTING.md) - opt-in CLI/MCP byte attribution, bounded receipt overhead, and release-level tokens-per-task baselines.
- [SDK Context Truth Contracts](SDK_CONTEXT_TRUTH_CONTRACTS.md) - typed tracker-root diagnostics and explicit merge-driver enforcement policy.
- [Self-Describing Context Contracts](SELF_DESCRIBING_CONTEXT_CONTRACTS.md) - intent-scoped reads, semantic flag invocation metadata, visibility parity, and generated error vocabulary.
- [Universal Read Output Contracts](READ_OUTPUT_CONTRACTS.md) - cross-command include, amount, cost, and encoding controls for CLI, SDK, MCP, and packages.
- [Mutation Integrity](MUTATION_INTEGRITY.md) - shared CLI/SDK/MCP author, secret, append-only disposition, and stale-work guardrails.
- [Agent Provenance ADR Amendment](AGENT_PROVENANCE_ADR.md) - extensible model, effort, role, and host provenance with privacy and compatibility boundaries.
- [SDK Agent Session and Episode Context](SDK_AGENT_SESSION_CONTEXT.md) - inherited role/topic context, cross-process episode identity, and deterministic history grouping.
- [SDK Context Coordination](SDK_CONTEXT_COORDINATION.md) - durable mutation events, bounded duplicate governance, and scale-safe package primitives.
- [Improvement Ledger and History Analytics](IMPROVEMENT_ANALYTICS.md) - audited quantitative observations, live provenance coverage, and bounded observational fleet outcomes.
- [SDK Evidence Traceability and Integrity](SDK_EVIDENCE_TRACEABILITY.md) - reverse source-to-item lookup, atomic evidence replacement, no-op history, linked-test collision classification, and telemetry drain receipts.
- [SDK Context Integrity Primitives](SDK_CONTEXT_INTEGRITY_PRIMITIVES.md) - batch duplicate discovery, structured errors, Plan evidence/lifecycle, sparse settings, tombstones, linked-test output, relocation diagnostics, and scoped output services.
- [SDK Context Integrity](SDK_CONTEXT_INTEGRITY.md) - truthful `get` projections, bounded annotation mutations, shared author coordinates, health provider boundaries, and changeset-aware replication gates.
- [Reproducible Workspaces and Snapshots](REPRODUCIBLE_WORKSPACES.md) - deterministic SDK recipes and content-addressed authoritative tracker restore points.
- [Portable Corpus Shapes](CORPUS_SHAPES.md) - versioned SDK populations for realistic benchmarks, evaluations, and package tests.
- [Agent UX Contracts](AGENT_UX_CONTRACTS.md) - ordering-cycle advisories, graph count units, collision safety, compact context, ownership wording, and recovery behavior.
- [Packages and Extensions](EXTENSIONS.md) - package install workflows, runtime extension lifecycle, and API reference.
- [Extension Lifecycle Contracts](EXTENSION_LIFECYCLE.md) - source identity, durable migrations, and scoped preflight ownership.
- [Extension Author Contracts](EXTENSION_AUTHOR_CONTRACTS.md) - the stability guarantees and contract surface package authors build against.
- [SDK](SDK.md) - public import surfaces and typed authoring examples.
- [Multi-Branch Merge Safety](MERGE_SAFETY.md) - semantic tracker merge drivers, post-merge integrity gates, delete/modify policy, and recovery-receipt retention.
- [Codex Plugin](CODEX_PLUGIN.md) - native MCP plugin install, tools, skills, and safety notes.
- [Native ChatGPT and Codex Plugin Implementation Plan](CHATGPT_CODEX_PLUGIN_IMPLEMENTATION.md) - official-source
  research, current-state audit, target architectures, security, testing, and phased remediation plan.
- [Claude Code Plugin](CLAUDE_CODE_PLUGIN.md) - native Claude Code plugin architecture and install flow.
- [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md) - root discovery (`--pm-path`), recovery bundles, and clear/unset semantics for automation maintainers.
- [Releasing](RELEASING.md) - maintainer release checklist and failure handling.
- [starter extension](examples/starter-extension/README.md) - compact extension scaffold reference.

## Guide Topic Map

| Optional `pm guide` topic | Primary docs                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `quickstart`              | [Quickstart](QUICKSTART.md), [Command Reference](COMMANDS.md)                                       |
| `commands`                | [Command Reference](COMMANDS.md), [Configuration](CONFIGURATION.md)                                 |
| `workflows`               | [Agent Guide](AGENT_GUIDE.md), [Testing](TESTING.md)                                                |
| `sdk`                     | [SDK](SDK.md), [Architecture](ARCHITECTURE.md)                                                      |
| `extensions`, `packages`  | [Packages and Extensions](EXTENSIONS.md), [starter extension](examples/starter-extension/README.md) |
| `skills`                  | [Agent Guide](AGENT_GUIDE.md) plus `.agents/skills/*`                                               |
| `harnesses`               | [Agent Guide](AGENT_GUIDE.md) plus `.agents/skills/HARNESS_COMPATIBILITY.md`                        |
| `release`                 | [Releasing](RELEASING.md), [CHANGELOG](../CHANGELOG.md)                                             |

Community files:

- [Agent operating rules](../AGENTS.md)
- [Product requirements](../PRD.md)
- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Changelog](../CHANGELOG.md)
- [License](../LICENSE)

## Agent Routing Rules

1. Start with [Agent Guide](AGENT_GUIDE.md) for workflow rules.
2. Use [Command Reference](COMMANDS.md) for command families, not exhaustive flag memory.
3. Use `pm <command> --help --json` or `pm contracts --command <name> --flags-only --json` for exact flags.
4. Use [Architecture](ARCHITECTURE.md) only when changing internals or debugging behavior.
5. Use [SDK](SDK.md) and [Packages and Extensions](EXTENSIONS.md) only when authoring or troubleshooting packages/extensions.

## Tracker References

Current documentation structure work is tracked through:

- [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon)

Legacy documentation baseline references (closed):

- [pm-3042](../.agents/pm/epics/pm-3042.toon) (closed)
- [pm-r9gu](../.agents/pm/features/pm-r9gu.toon) (closed)
- [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon) (closed)

When changing docs, link files back to the active item:

```bash
pm docs <item-id> --add path=docs/README.md,note="documentation index"
pm comments <item-id> "Docs updated; links and build verified."
```

## Public Boundary

Public docs must not link to ignored local operations artifacts, unpublished evidence logs, credentials, host-specific runbooks, or private service details. Keep those materials local and out of packaged releases.

## Maintenance Checklist

- Keep links relative and GitHub-compatible.
- Keep README short; move detail into focused pages.
- Put a short "Agent Quick Context" near the top of deep docs.
- Prefer commands that agents can copy exactly.
- Use `pm` item IDs as durable references when docs explain tracked work.
- Run link/search checks before closing documentation tasks.
