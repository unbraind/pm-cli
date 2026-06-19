# CLI Simplification Migration (Conservative Full-Surface Pass)

This note documents behavioral and output-shape changes introduced in the conservative CLI simplification pass.

## What Changed

### 1) Command invocation normalization before Commander parse

`pm` now normalizes invocation tokens before Commander parses them:

- long-flag shape normalization (`--foo_bar` / camel variants -> canonical kebab flags)
- high-confidence typo normalization for long flags
- `key=value` / `key:value` promotion into canonical `--flag value` tokens when unambiguous
- legacy `pm extension <action>` shorthand normalization to explicit action flags

Normalization runs across command families and preserves a normalization trace for diagnostics and recovery.

### 2) Setup-agnostic PM root discovery

`resolvePmRoot()` precedence is now:

1. explicit `--pm-path` (or its compatibility alias `--path`)
2. `PM_PATH`
3. upward discovery of initialized `.agents/pm` roots (must contain `settings.json`)
4. local default (`<cwd>/.agents/pm`)

`--pm-path` is the preferred explicit flag; `--path` remains a backward-compatible
alias for the same tracker-storage directory (not a workspace/cwd flag). An
explicit path that points at a project root is redirected to its `.agents/pm`
subdirectory (pm-ryik), so `--pm-path <repo>` and `--pm-path <repo>/.agents/pm`
resolve to the same tracker. See [Configuration](CONFIGURATION.md) for the
current contract.

If you need the old local-only behavior from nested directories, pass an explicit path (`--pm-path .agents/pm`).

### 3) Structured recovery bundles in CLI error output

Error payloads now include optional `recovery` metadata in text and JSON guidance surfaces:

- `attempted_command`
- `normalized_args`
- `provided_fields`
- `missing`
- `suggested_retry`

Automation should read this bundle for deterministic retries instead of rebuilding retries from free-form error text.

### 4) Legacy `none`/`null` compatibility in create/update

For deterministic compatibility:

- scalar `none` / `null` values on unset-capable fields are reinterpreted as `--unset <field>`
- repeatable `none` / `null` values are reinterpreted as their matching `--clear-*` action
- mixed legacy clear token + concrete repeatable payloads remain rejected (ambiguous input)

## Migration Guidance for Automation

- **Prefer contracts first**: keep using `pm contracts --json` and command-scoped flag contracts.
- **Consume `recovery` directly**: treat `recovery.suggested_retry` as first-choice replay command.
- **Do not hardcode old error envelopes**: parsers should tolerate additional fields (`recovery`) and richer guidance text.
- **Avoid relying on local cwd-only root resolution**: pass `--path` explicitly when wrappers need fixed data roots.
- **Update none/null assumptions**: if your tests expected hard failures for pure `none`/`null` clear intents, update them to expect deterministic clear/unset behavior.

## Verification Checklist

- `tests/unit/bootstrap-args.spec.ts`
- `tests/unit/store-paths.spec.ts`
- `tests/integration/help-runtime.spec.ts`
- `tests/unit/create-command.spec.ts`
- `tests/unit/update-command.spec.ts`

