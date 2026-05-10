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

- `.pi/extensions/pm-cli/index.js` — native Pi extension registering the `pm` tool and slash commands.
- `.pi/skills/*` — Pi skills for native pm workflows and release validation.
- `.pi/prompts/*` — prompt templates for pm-tracked work.

The extension imports the built package from `dist/`, so run `pnpm build` before local install or before publishing.
