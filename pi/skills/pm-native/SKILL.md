---
name: pm-native
description: Native pm integration for Pi. Use when planning, claiming, updating, linking files/tests/docs, validating, or closing pm CLI work through the Pi pm tool instead of shelling out to the pm CLI.
license: MIT
compatibility: Pi coding-agent with the @unbrained/pm-cli Pi package installed.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: pi-native
---

# pm Native for Pi

Use the `pm` tool for project-management operations. Do not run `pm ...` through bash when the native tool is available.

## Required Loop

1. Orient before creating work:
   - `pm` action `context` with `limit: 10`
   - `pm` action `search` with relevant keywords
   - `pm` action `list-open` and `list-in-progress`
2. Claim work with action `claim` or `start-task`.
3. Mutate with explicit `author`.
4. Link evidence:
   - action `files` with `add`
   - action `docs` with `add`
   - action `test` with sandbox-safe commands
5. Verify with action `test`, `validate`, and project test commands when appropriate.
6. Close with action `close-task` or `close`, then release if needed.

## Common Tool Calls

- Context: `{ "action": "context", "limit": 10 }`
- Search: `{ "action": "search", "query": "pi native extension", "limit": 10 }`
- Claim: `{ "action": "claim", "id": "pm-1234", "author": "pi-agent" }`
- Link file: `{ "action": "files", "id": "pm-1234", "add": ["path=src/file.ts,scope=project,note=implementation"], "author": "pi-agent" }`
- Add comment: `{ "action": "comments", "id": "pm-1234", "add": ["Evidence: build and tests passed"], "author": "pi-agent" }`
- Close: `{ "action": "close-task", "id": "pm-1234", "text": "All acceptance criteria met", "author": "pi-agent", "validateClose": "warn" }`

Use `pm guide` topics through action `guide` for deeper command docs.
