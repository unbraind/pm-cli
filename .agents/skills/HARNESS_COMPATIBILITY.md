# Harness Compatibility

This repository supports the following harnesses through shared docs and `.agents/skills` workflows only (no harness-specific runtime code):

- Pi coding agent
- OpenClaw
- Claude Code
- Codex CLI
- OpenCode
- Amp
- Droid
- Hermes
- Gemini CLI

## Progressive-Disclosure Route

Use the same low-token route in every harness:

1. `pm guide` (topic index)
2. `pm guide <topic>` (focused route)
3. `pm guide <topic> --depth standard|deep` (details only when needed)
4. `pm contracts --command <command> --flags-only --json` (strict machine flags)

## Harness Mapping

| Harness | Preferred prompt/doc entrypoint | Skill route |
|---------|----------------------------------|-------------|
| Pi coding agent | `AGENTS.md` + `pm guide workflows` | `.agents/skills/pm-developer/SKILL.md` |
| OpenClaw | repository docs + `pm guide` | `.agents/skills/pm-user/SKILL.md` |
| Claude Code | repository docs + `pm guide skills` | `.agents/skills/pm-developer/SKILL.md` |
| Codex CLI | repository docs + `pm guide commands` | `.agents/skills/pm-developer/SKILL.md` |
| OpenCode | repository docs + `pm guide quickstart` | `.agents/skills/pm-user/SKILL.md` |
| Amp | repository docs + `pm guide workflows` | `.agents/skills/pm-user/SKILL.md` |
| Droid | repository docs + `pm guide extensions` | `.agents/skills/pm-extensions/SKILL.md` |
| Hermes | repository docs + `pm guide sdk` | `.agents/skills/pm-sdk/SKILL.md` |
| Gemini CLI | repository docs + `pm guide commands` | `.agents/skills/pm-user/SKILL.md` |

## Verification

Before release, run:

```bash
pm guide skills --depth standard
node scripts/release/docs-skills-gate.mjs
```
