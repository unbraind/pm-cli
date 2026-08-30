# pm Agent Skills

`agentskills.io`-style skill bundles for `pm` workflows, written for
progressive disclosure: each `SKILL.md` is a router of roughly one screen, each
`references/*.md` is a bounded expansion, and the exhaustive surface is fetched
at runtime from contracts rather than copied into prose that can drift.

## Load Order

| Tier | Source                                 | Typical cost | Staleness risk |
| ---- | -------------------------------------- | ------------ | -------------- |
| 0    | `SKILL.md`                             | ~650 tok     | Gated          |
| 1    | `pm next`, `pm context`, `pm search`   | ~0.5-2.5k    | None (live)    |
| 2    | `pm contracts ...`, `pm <cmd> --help --json` | ~1-3.4k | None (generated) |
| 2    | `pm guide <topic> --depth brief`       | ~0.6-1k      | Gated          |
| 3    | `references/*.md`                      | ~0.3-1k each | Gated          |
| 4    | `docs/*.md`                            | 0.7k-45k     | Gated          |

Never load a tier-4 document whole when a reference routes into a section of
it. `docs/COMMANDS.md` is ~29k tokens and `docs/SDK.md` is ~45k.

## Bundles

| Skill                             | Use when                                              |
| --------------------------------- | ------------------------------------------------------ |
| [`pm-developer`](pm-developer/SKILL.md) | Changing code, docs, tests, or release gates      |
| [`pm-user`](pm-user/SKILL.md)     | Intake, triage, prioritization, planning, reporting    |
| [`pm-extensions`](pm-extensions/SKILL.md) | Package and extension lifecycle and authoring  |
| [`pm-sdk`](pm-sdk/SKILL.md)       | Integrations, embedding, and domain packs on the SDK   |

Harness-specific bundles ship with the plugins under `plugins/pm-claude/skills`
and `plugins/pm-codex/skills`; they route to the same guide topics and
contracts.

## Runtime Routing

```bash
pm package install guide-shell --project
pm guide                       # topic index
pm guide skills
pm guide harnesses --depth standard
```

Guide topics: `quickstart`, `commands`, `workflows`, `sdk`, `extensions`,
`skills`, `harnesses`, `release`, `tokens`, `graph`, `assurance`, `merge`.

Compatibility routing: [Harness compatibility matrix](HARNESS_COMPATIBILITY.md)
