# Context and operations command namespaces

Tracked in [pm-kcs4](../.agents/pm/tasks/pm-kcs4.toon),
[pm-6apl](../.agents/pm/tasks/pm-6apl.toon), and
[pm-3i9q8g](../.agents/pm/tasks/pm-3i9q8g.toon).

The CLI groups navigation and maintenance under stable nouns. Existing root
spellings remain executable compatibility aliases with the same arguments,
results, exit codes, and SDK behavior.

| Native invocation | Compatibility spelling | Purpose |
| --- | --- | --- |
| `pm context next` | `pm next` | Select ready work and explain blockers |
| `pm context focus` | `pm focus` | Read, set, or clear the focused item |
| `pm ops stats` | `pm stats` | Inspect tracker statistics |
| `pm ops health` | `pm health` | Diagnose tracker health |
| `pm ops validate` | `pm validate` | Validate metadata and history |
| `pm ops gc` | `pm gc` | Clean optional cache artifacts |
| `pm ops telemetry` | `pm telemetry` | Inspect and manage telemetry |
| `pm ops eval` | `pm eval` | Evaluate retrieval quality |
| `pm ops test-all` | `pm test-all` | Run selected linked tests |
| `pm ops reindex` | `pm reindex` | Refresh indexes through search-advanced |
| `pm ops normalize` | `pm normalize` | Normalize through an active governance package |
| `pm history events` | `pm events` | Read or follow committed mutation events |

`pm context --limit 10 --for orient` still produces a context snapshot.
`pm history <id> --verify` still reads and verifies one item's history.
Namespace leaves do not change either default operation.

## Discover only what the current task needs

```bash
pm context next --limit 5 --ready-only
pm context focus --id pm-example
pm ops health --check-only --summary
pm ops validate --check-history-drift
pm history events --item pm-example --limit 10
pm ops --help
pm contracts --command "ops stats" --flags-only
```

Help, contracts, and shell completion expose native paths. Compatibility aliases
remain declared in the SDK alias table. Alias guidance uses the existing
`ux.deprecation_hints` setting. Human-readable calls emit it on stderr; JSON and
quiet calls suppress it. Compact contract summaries omit duplicate root alias
rows; full and explicitly selected contracts retain them. Optional commands appear only when their providing package is active;
namespace placement does not promote package behavior into core.

## SDK and package integration

`PM_NAMESPACED_COMMAND_ALIASES` and `resolvePmCommandOperation` are exported
from `@unbrained/pm-cli/sdk` and `@unbrained/pm-cli/sdk/contracts`.
The resolver maps a native path such as `context next` to the existing SDK
operation identity `next`. Unknown paths are preserved. SDK functions, MCP
action names, extension activation selectors, and command hooks retain their
existing operation identities.

Packages that provide `reindex` or `normalize` keep their existing command
registration. The CLI places the registered handler beneath `ops` after
activation, preserving flags, argument parsing, and nested commands. A conflicting
native destination fails explicitly instead of silently replacing a handler.

Generated Bash, Zsh, and Fish scripts recognize namespace command positions and
skip global option values when selecting a leaf. Re-generate installed completion
scripts after upgrading with `pm completion <shell>` from guide-shell.
