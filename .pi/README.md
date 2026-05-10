# pm CLI Pi Package

This directory is the installable Pi package payload for `@unbrained/pm-cli`.

Install from npm after publish:

```bash
pi install npm:@unbrained/pm-cli
```

For local development from a checkout:

```bash
pnpm build
pi install -l .
# or one-shot
pi -e .
```

Resources exposed by `package.json`:

- `.pi/extensions/pm-cli/index.js` — native Pi extension registering the `pm` tool, custom TUI renderers, autocomplete, status/widget UI, and slash commands.
- `.pi/skills/*` — Pi skills for native pm workflows and release validation.
- `.pi/prompts/*` — prompt templates for pm-tracked work.
- `.pi/agents/*` and `.pi/chains/*` — optional pi-subagents setup for pm triage and verification workflows in repositories that use subagents.

The extension imports the built package from `dist/`, so run `pnpm build` before local install or before publishing.

Interactive commands:

- `/pm-board [limit]` — dashboard panel for active pm context.
- `/pm-item <id>` and `/pm-history <id>` — item details/history panels.
- `/pm-actions` and `/pm-workflows` — native action list and workflow reminders.

The `pm` tool should be preferred over shelling out to `pm`; it calls pm command modules directly in-process.
