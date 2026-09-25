# Agent Recovery and Guidance

Tracked by [pm-o5s22y](../.agents/pm/issues/pm-o5s22y.toon) and
[pm-80k965](../.agents/pm/issues/pm-80k965.toon).

## Policy refusals preserve context

A workflow `require_fields` refusal names the missing metadata and the policy
that requires it. SDK `PmCliError.context` carries `policy_violations`, the
full refusal count, policy descriptions, and missing-field recovery. CLI JSON
adds that same evidence to `refusal.policies` and `refusal.missing_fields`.
Its `surface` identifies `policy:<id>` rather than attributing the failure to
an unrelated, valid flag such as `--resolution`.

Diagnostics show at most three policy rows and disclose the total. The complete
policy remains available through `pm schema policies`. Recovery maps metadata
to declared update flags; package-defined fields retain their SDK/package
contract instead of receiving an invented CLI option. For example, a missing
`actual_result` produces an update using `--actual-result`, followed by a retry
of the refused operation. Refusals preserve item state and record the policy
refusal in workspace history. Creation and import refusals instead direct the
caller to supply evidence in the original request, because no item was created.
Generated update commands include a shell-quoted `--pm-path` to retain the
refusing tracker even when an SDK caller works outside that project.

See [Declarative Workflow Policies](WORKFLOW_POLICIES.md) for portable policy
declarations and approval semantics.

## Refresh managed agent instructions

Root and alias help examples use canonical commands. Help for a deprecated
alias explicitly identifies its replacement. Generated instructions use
`pm claim <id> --start` to claim and start work atomically.

`pm init --agent-guidance status` compares existing managed blocks with the
current template. `pm health --summary` reports `agent_guidance_outdated` as an
advisory and supplies this repair command:

```bash
pm init --agent-guidance add
```

The repair refreshes stale managed blocks in both `AGENTS.md` and `CLAUDE.md`,
preserves all surrounding user instructions, and becomes a no-op after the
first successful refresh. It does not replace handwritten guidance without
managed markers. Status and health inspection do not rewrite these files.
An unreadable guidance path produces an `agent_guidance_unreadable` advisory;
health still reports the remaining checks and suggests inspecting file types
and read permissions.
