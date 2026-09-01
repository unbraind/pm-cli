# Context Integrity and Recovery Primitives

Tracker: [pm-dn8rwl](../.agents/pm/issues/pm-dn8rwl.toon), [pm-r97901](../.agents/pm/issues/pm-r97901.toon), [pm-hu92i3](../.agents/pm/issues/pm-hu92i3.toon), [pm-nc94mk](../.agents/pm/issues/pm-nc94mk.toon), [pm-xrjy8o](../.agents/pm/issues/pm-xrjy8o.toon), [pm-f60039](../.agents/pm/issues/pm-f60039.toon), [pm-2qahia](../.agents/pm/issues/pm-2qahia.toon), [pm-z1z96w](../.agents/pm/issues/pm-z1z96w.toon), [pm-yhle2e](../.agents/pm/issues/pm-yhle2e.toon), [pm-t7wl00](../.agents/pm/issues/pm-t7wl00.toon), [pm-hiqlkh](../.agents/pm/issues/pm-hiqlkh.toon), [pm-ntnv4k](../.agents/pm/issues/pm-ntnv4k.toon), [pm-sxg7wl](../.agents/pm/issues/pm-sxg7wl.toon), [pm-xspd](../.agents/pm/chores/pm-xspd.toon)

`project management = context management`: a successful command is useful only when the context it records and later returns is truthful, lossless, and actionable. These SDK-owned primitives are shared by the CLI and package integrations.

## Lossless structured values

CSV-style structured metadata preserves whitespace following literal commas. An escaped comma (`\,`) is consumed as one literal comma. Prefer quoted or structured forms when a value itself contains delimiters:

```bash
pm files pm-123 --add 'path="docs/name,with-comma.md",scope=project'
pm update pm-123 --annotation 'key=summary,value=Alpha\, beta'
```

Bare comma-separated file and documentation paths are refused because the CLI cannot know whether the comma separates two paths or belongs to one filename. Repeat the option for multiple values. A linked-test command followed by a structured tuple, such as `command,scope=project`, is refused for the same reason; use `command=<value>,scope=project`.

## Linked path write receipts

`pm files --add`, `pm docs --add`, and path migrations validate the resulting paths when the mutation changes stored metadata. The result includes `validation.missing_paths`, `validation.non_file_paths`, and `validation.remote_references`. Missing local paths remain permitted as deliberate forward references, but they are visible in the write receipt instead of becoming silent durable context.

## Executed-test evidence

A linked runner command carrying a name filter must execute at least one test. An explicit zero-test runner summary is classified as `failure_category: empty_run`, even when the process exits zero. A zero-pass count alone is not an empty-run receipt when the runner reports a positive test count. Filtered commands without either positive execution evidence or an explicit zero-test signal fail closed as `missing_positive_execution_receipt`; unfiltered commands retain the explicit `--fail-on-empty-test-run` policy.

## External blockers

URL and named external locators are not dangling local item identifiers. Validation excludes them from local dangling-reference remediation, and graph assembly materializes them as external predecessor nodes. Until an integration resolves the remote state, `pm next` retains the blocker and reports:

- `external: true`
- `blocked_since`: the holder's conservative last-mutation timestamp
- `resolver: null`

This makes an unverifiable or stale dependency visible without suggesting destructive removal.

Packages can add provider-specific resolution without coupling core to GitHub, Jira, Linear, or another service. Register an `ExternalDependencyResolver` through the public SDK and dispose it when the package deactivates. The SDK normalizes lifecycle state to `open`, `closed`, or `unknown`; caps remote titles at 240 characters and evidence locators at 2,048 characters; records `checked_at` plus the registered resolver name; and treats only trusted `closed` evidence as resolved. Provider errors and unsupported locators fail closed so another registered resolver can handle the reference or the blocker remains explicitly unverifiable.

## Package-manager receipt compatibility

The npm package source accepts both documented receipt families:

- npm 11: an array of package receipt objects
- npm 12: an object keyed by package name

When multiple entries exist, the SDK selects the requested package by key or `name`. A well-formed but unsupported or ambiguous JSON value fails with `npm_pack_json_shape_unsupported`; filename-only fallback is used only for genuinely non-JSON legacy output.

## History and merge recovery

History hash capability 3 distinguishes the current canonical writer surface
from older writers while retaining frozen readers for epochs 1 and 2. Two
writer surfaces were historically emitted under epoch 2: its earlier form
excluded linked-test workspace/provenance fields and test-run execution
receipts while normalizing dependency ids; its later form included those
fields. Verification recognizes both immutable forms and requires each entry's
before/after hashes to use one consistent form. Current-document verification
selects the candidate that matches the verified chain head. An unsupported
epoch is version skew, not permission to reinterpret or silently normalize
history.

Health keeps the metadata-only cache path for clean history streams. A cached hash mismatch, chain mismatch, or writer-version skew is only a candidate: health rereads canonical item sources and verifies stream content hashes before reporting corruption. The `history_drift` details expose `cache_confirmation` candidate, confirmed, and resolved-false-positive item sets, while `cache_hit_verification: metadata_then_content_hash` identifies the authoritative fallback. Drift-cache envelopes carry both their schema version and the current item-hash capability, so changing legacy canonicalization invalidates prior verdicts and a runtime with incompatible hash semantics rebuilds the cache instead of trusting it.

Merge reconciliation may consume a durable hash-only receipt without `--force` only when its canonical item path, complete declared-field set, and every merged-value hash exactly match the current item snapshot. Raw discarded values remain clone-local. Any incomplete or mismatched proof fails closed. SDK gates use `inspectMergeReceiptEvidence` or `runMergeReceiptEvidenceReport` to retain the distinction between no evidence, rejected evidence, and clone-local evidence whose Git directory could not be resolved; `clone_local_evidence_resolved=false` makes the loss-aware report incomplete. Rejected evidence carries bounded privacy-safe source, reason, and receipt-id-or-hash locators, while the exact count and truncation receipt preserve completeness under an agent token budget. Cross-platform ancestor inspection distinguishes an absent receipt store from an unreadable or non-directory root. The list-only and legacy report compatibility projections intentionally return valid receipts only. Diverged history unions also fail closed when deterministic suffix ordering would make any patch operation inapplicable, instead of publishing a rehashed stream with a skipped branch effect.

History receipt summaries are durable references, not cleanup hints. Health
checks each `context.merge.receipts[].receipt_id` against valid pending and
reconciled authoritative evidence. A missing reference is returned with its
item id and one-based history line; unsafe identifiers are SHA-256 locators
rather than echoed content. Detail is capped at 100 while the exact count and a
truncation receipt preserve loss awareness. Recovery means restoring the named
receipt from an authoritative clone or backup. Rewriting append-only history or
deleting sibling evidence is never an automatic remediation.

## Strict-create recovery

When strict governance requires a collection, the recovery bundle lists the truthful empty declaration before an example that adds metadata:

```text
--clear-deps, --dep, --create-mode progressive
```

The same contract covers comments, docs, events, files, learnings, notes, reminders, tests, and type options. Agents should never invent an edge or evidence row merely to satisfy a required-field gate.

## Duplication gates

`pnpm lint:duplicates` runs both the repository-wide clone gate and a lower-line production-source profile. The source profile covers `src`, `packages`, and `plugins` so a compact clone reported by hosted analysis cannot hide below the broader repository threshold.
