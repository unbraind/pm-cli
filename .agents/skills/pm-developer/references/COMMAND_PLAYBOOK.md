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
pm list-open --limit 20
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
pm guide workflows
pm guide commands --depth standard
pm guide release --json
```
