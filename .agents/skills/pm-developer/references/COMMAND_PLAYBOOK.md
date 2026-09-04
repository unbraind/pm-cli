# Developer Command Playbook

## Session Bootstrap (Maintainer Run)

```bash
npm install -g .
pm --version
node -v
pnpm -v
pnpm build
```

## Item Lifecycle

```bash
pm context --limit 10
pm search "<keywords>" --limit 10
pm list --status open --limit 20
pm claim <ID>
pm update <ID> --status in_progress --description "..."
pm append <ID> --body "Implementation notes"
```

## Evidence Linking

```bash
pm files <ID> --add path=src/<file>.ts,scope=project,note="implementation"
pm docs <ID> --add path=docs/<doc>.md,scope=project,note="public docs update"
pm test <ID> --add command="node scripts/run-tests.mjs test -- tests/unit/<file>.spec.ts",scope=project,timeout_seconds=240
```

## Durable Knowledge And Record Maintenance

```bash
pm learnings <ID> --add "<lesson that applies beyond this item>"
pm learnings <ID> --limit 5
pm history <ID> --verify --strict-exit
pm history-repair --all --dry-run
pm close-many --ids <ID>,<ID> --reason "<shared reason>" --dry-run
```

## Close Workflow

```bash
pm test <ID> --run --progress
node scripts/run-tests.mjs coverage
pm comments <ID> "Evidence: linked tests passed; coverage remained green."
pm close <ID> "Acceptance criteria met with verification evidence." --validate-close warn
pm release <ID>
```

## Local Docs Routing

```bash
pm package install guide-shell --project
pm guide workflows
pm guide commands --depth standard
pm guide release --json
```
