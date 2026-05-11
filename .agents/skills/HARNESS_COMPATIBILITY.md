# Harness Compatibility

This repository supports external automation harnesses through shared docs and `.agents/skills` workflows only. Harness-specific runtime code belongs in separate adapter packages, not in the main `pm` CLI or SDK.

## Progressive-Disclosure Route

Use the same low-token route in every harness:

1. `pm guide` (topic index)
2. `pm guide <topic>` (focused route)
3. `pm guide <topic> --depth standard|deep` (details only when needed)
4. `pm contracts --command <command> --flags-only --json` (strict machine flags)

## Harness Mapping

| Harness need | Preferred prompt/doc entrypoint | Skill route |
|--------------|----------------------------------|-------------|
| Development loop | `AGENTS.md` + `pm guide workflows` | `.agents/skills/pm-developer/SKILL.md` |
| User/operator workflow | repository docs + `pm guide quickstart` | `.agents/skills/pm-user/SKILL.md` |
| Package authoring | repository docs + `pm guide extensions` | `.agents/skills/pm-extensions/SKILL.md` |
| SDK integration | repository docs + `pm guide sdk` | `.agents/skills/pm-sdk/SKILL.md` |

## Verification

Before release, run:

```bash
pm guide skills --depth standard
node scripts/release/docs-skills-gate.mjs
```
