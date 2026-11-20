# Testing

This page describes sandbox-safe linked tests: how `pm test` runs, isolates and
trusts the commands an item links. The checks this repository runs on itself
(standard local checks, CI layout and retries, coverage governance, quality
gates and release readiness) live in
[Repository Testing](https://github.com/unbraind/pm-cli/blob/main/docs/REPOSITORY_TESTING.md)
(repository-only, excluded from the npm package).

Current linked-test and merge-fence work: [pm-t05d8d](../.agents/pm/issues/pm-t05d8d.toon), [pm-kynkl8](../.agents/pm/issues/pm-kynkl8.toon).

Tracked implementation updates: [pm-52eh](../.agents/pm/features/pm-52eh.toon), [pm-mcxr](../.agents/pm/issues/pm-mcxr.toon), [pm-u42x](../.agents/pm/issues/pm-u42x.toon), [pm-atfm](../.agents/pm/features/pm-atfm.toon), [pm-xmp5](../.agents/pm/tasks/pm-xmp5.toon), [pm-39cqqx](../.agents/pm/tasks/pm-39cqqx.toon), [pm-5cgm2z](../.agents/pm/chores/pm-5cgm2z.toon), [pm-avv3wx](../.agents/pm/issues/pm-avv3wx.toon), [pm-rizqb6](../.agents/pm/issues/pm-rizqb6.toon), [pm-95h7pg](../.agents/pm/issues/pm-95h7pg.toon), [pm-giks4s](../.agents/pm/issues/pm-giks4s.toon), [pm-xa3t0o](../.agents/pm/issues/pm-xa3t0o.toon), [pm-e97jyf](../.agents/pm/issues/pm-e97jyf.toon), [pm-efkvdy](../.agents/pm/issues/pm-efkvdy.toon), [pm-ed28wi](../.agents/pm/issues/pm-ed28wi.toon), and [pm-5ug5xq](../.agents/pm/issues/pm-5ug5xq.toon).

## Agent Quick Context

- Unit and integration tests must not read or write real `.agents/pm` data.
- Prefer `node scripts/run-tests.mjs ...` because it creates sandboxed `PM_PATH` and `PM_GLOBAL_PATH`.
- Linked-test execution injects isolated `PM_GLOBAL_PATH` and normally
  `PM_PATH`; `pm_context_mode=none` omits `PM_PATH` for self-isolating SDK tests
  in disposable workspaces. It applies stored-command provenance checks before process
  creation. Direct runners are accepted; prefer
  `node scripts/run-tests.mjs ...` when the repository provides it because the
  wrapper also reproduces build, coverage, and cleanup policy. Use a direct
  runner when a `none`-mode test must observe an unset `PM_PATH`; the wrapper
  creates its own sandboxed `PM_PATH`.
- Run linked tests before closing the item that owns the work.

Linked tests classify a confirmed missing executable as `spawn_error`, retaining
the shell's exit code and exact stderr. Confirmation requires a literal leading
executable, the shell's named lookup diagnostic and a failed lookup using the
execution's environment and working directory. On POSIX, a resolved script may
also qualify when a bounded shebang read confirms its absolute interpreter is
absent. The script is never rerun to probe startup. A child deliberately exiting
127, arbitrary `ENOENT` output, compound shell programs, expansions, and an
unavailable lookup probe retain their existing classification. A killed or
signaled resolver cannot establish absence, even if its reported code is 1.
The required native fixture captures the real lookup's status, signal, kill
flag, duration, working directory and effective child-environment equality. It
requires the category established by that independent evidence; unavailable
proof must remain an assertion failure. Environment values are not logged.
This conservative
rule supports POSIX shells and Windows command lookup; it does not infer setup
failure from arbitrary runner output
([pm-gh1604](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1604.toon); tracker record excluded from npm).
Interpreter verification and replay evidence:
[pm-script-launch-evidence](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-script-launch-evidence.toon)
(tracker record excluded from npm).
Native resolver evidence:
[pm-windows-lookup-proof](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-windows-lookup-proof.toon)
(tracker record excluded from npm).

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

Local/hosted gate parity is tracked by [pm-ei6x66](../.agents/pm/tasks/pm-ei6x66.toon).

## Linked Tests

For in-place metadata corrections and context admission/refusal semantics, see
[Linked-test edits](LINKED_TEST_EDITS.md).

Run-option admission is tracked by
[pm-hdvxqg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hdvxqg.toon)
(a repository-only tracker record excluded from npm).
`pm test` requires `--run` for `--timeout`, `--progress`, execution context,
environment directives, and run selectors. Registration-only calls refuse these
options before saving links. Combined edits and execution validate the effective
post-edit selection under the item lock before persistence, including out-of-range
indexes and unmatched selectors. These admission errors carry `changed: false`
in structured output. A valid request that executes a failing child can still
save its accepted edits and execution evidence; inspect its run results before
retrying.

Add tests to the item that owns the work:

```bash
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/output.spec.ts",timeout_seconds=240
pm test <item-id> --run --progress
```

For broader sweeps:

```bash
pm test-all --status in_progress --progress
```

`--add` and `--add-json` only record a command; nothing executes until `--run`.
A metadata-only correction therefore never re-runs a suite: edit the stored
entry with `--update-index <n> --set-json '{...}'` (see
[Linked-test edits](LINKED_TEST_EDITS.md)).

### Setup entries

Tracked by
[pm-gh1671](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1671.toon)
(a repository-only tracker record excluded from npm). A linked test declared
with `phase=setup` is a step the item's regular linked commands depend on, such
as building the output that specs import:

```bash
pm test <item-id> --add "command=npm run build,phase=setup"
pm test <item-id> --add-json '{"command":"npm run build","phase":"setup"}'
pm test <item-id> --run
```

- Every setup entry runs first, in stored order, once per `pm test --run`,
  inside the same sandbox as the regular commands, so its output is what they
  see. Entries share an execution root only within one workspace context mode
  (the source checkout, the run's isolated root, or the run's snapshot, which
  is seeded before any entry runs). A setup entry whose mode differs from a
  command it prepares is therefore refused with `config_refusal` before it
  executes; set `workspace_context_mode` on the setup entry and its commands to
  one mode. A selector (`--match`, `--only-index`,
  `--only-last`) that names a regular command still runs the setup entries
  first; `selection.setup_indexes` lists the ones it did not name, and
  `selection.selected_indexes` is in run order. A selector naming only setup
  entries runs just those.
- A setup entry that fails is reported with `failure_category: setup_failed`
  (its original classification stays in `setup_failure_cause`) and counted
  under `failure_categories.setup_failed`, separately from test failures. A
  setup entry that never executes (a runtime safety skip, or an entry without a
  command) is a `setup_failed` failure too. A refused setup entry keeps its own
  category (for example `trust_refusal` or `config_refusal`). In every case
  each later entry is reported as `skipped` without executing, and the run fails.
- Setup rows carry `phase: setup`. They are exempt from
  `--fail-on-empty-test-run`, `--require-assertions-for-pm` and the implicit
  receipt check for test-name filters such as `--test-name-pattern`, which
  describe test runners (explicit `assert_*` metadata still applies), and they
  never count as the executed linked test that `--measure` requires.
- `pm test-all` runs each item's setup entries for that item, each with its own
  timeout, and never deduplicates them across items: in an isolated or snapshot
  workspace a setup's output stays in its own item's sandbox. A regular command
  is deduplicated across items only when the items' setup entries match, a setup
  refused before dispatch blocks the rest of its item, and an item whose setup
  did not pass leaves its regular commands free to run for a later item.
- The SDK's `runLinkedTests` applies the same order itself: whatever order the
  caller passes, setup entries run first and results come back in run order.
- Setup entries are executable data under the same provenance and clone-trust
  rules as every linked command. `phase` is editable metadata
  (`--set-json '{"phase":"setup"}'`, or `null` to make the entry a regular test
  again) and is not part of the trust fingerprint.
- An item with a setup entry is stored at item format 3, so hosts that predate
  the phase refuse the item instead of silently dropping the field (see
  [Published Workspace Compatibility](https://github.com/unbraind/pm-cli/blob/main/docs/REPOSITORY_TESTING.md#published-workspace-compatibility), repository-only and excluded from npm).
  Create, edits and the SDK import writer (`commitImportedItem`) all stamp it
  through `stampRequiredItemFormat`, and package import adapters keep
  `phase: setup` through an export and re-import.

Do not link `pm test-all` itself as an item-level test command. It creates recursive orchestration.
Use `--fail-on-empty-test-run` for release/readiness gates where selecting zero
linked tests should fail instead of producing an inconclusive pass.
Use `--progress` for long foreground sweeps; it prints parent-level
`pm test-all` selection, per-item start/end, and final summary lines in addition
to the linked-test command progress emitted by `pm test`.

## PM Context Modes

Linked PM commands default to schema context: settings and extensions are seeded, but tracker item data stays isolated.
When a linked command is a PM tracker-read such as `pm validate`, the default mismatch error suggests
`--auto-pm-context`, which keeps schema isolation for ordinary commands and routes only tracker-read PM commands
through seeded tracker data.

The runner resolves every selected command's effective context before it
creates temporary sandboxes. Runs whose effective context is schema initialize
only their schema roots; a non-PM command explicitly configured with
`pm_context_mode: "tracker"` still requires tracker data. Tracker roots and item
data are materialized only when at least one selected command requires tracker
context. This preserves source isolation without copying an unrelated tracker
into constrained temporary storage.
For SDK tests that create independent temporary PM roots, use
`pm_context_mode: "none"` with `workspace_context_mode: "isolated"` or
`"snapshot"`. The runner omits `PM_PATH` so each SDK client can resolve its
explicit workspace independently; `PM_GLOBAL_PATH` remains sandboxed. Source
workspace execution and direct PM commands refuse this mode before execution.
Capacity, permission, and resource failures while seeding a required tracker
surface as typed, path-redacted host-environment refusals with recovery steps.
When a legacy source tracker has settings but no `_workspace` history, tracker
mode creates the sandbox's initial audited settings snapshot from the exact
source bytes. Existing source workspace history is copied unchanged, including
real drift, so linked validation never masks a source integrity failure.

## Source Workspace Modes

Linked tests have a separate source-workspace contract. Store a default on one
entry with `workspace_context_mode`, or choose a run-level mode with
`--workspace-context`:

```bash
pm test <item-id> --add-json '{"command":"pnpm quality:static","workspace_context_mode":"isolated"}'
pm test <item-id> --run --workspace-context snapshot --override-linked-workspace-context
```

- `source` (default) runs in the source checkout and exposes its read-only
  source-context environment, preserving existing linked-test behavior.
- `isolated` runs from an empty disposable directory and removes
  `PM_SOURCE_WORKSPACE_ROOT`, `PM_SOURCE_PM_PATH`, and the source-context access
  declaration. Use it only for commands that do not require checkout files.
- `snapshot` copies the workspace into the linked-test sandbox, runs from that
  copy, and binds its `.agents/pm` path to the selected temporary tracker.
  `.git`, `.agents`, coverage output, and common cache directories are excluded
  at every directory depth, with reserved names matched case-insensitively for
  portable admission. Git sources receive an independent commit/tag object store
  with an index initially based on HEAD, fresh configuration, no source hooks,
  and no origin remote. Repository
  history remains available; this is execution isolation, not history redaction.
  Receipt verification is tracked by [pm-ycyymg](../.agents/pm/issues/pm-ycyymg.toon).
  Source-mode tracker copies authenticate matching durable receipts against the
  explicitly inherited read-only source index. Snapshot-mode copies use their
  own index and the exact bound tracker path. Only bounded stage-zero receipt
  blobs from the selected source tracker index are copied into that independent
  object store and rebased into the snapshot namespace, including staged-only
  receipts and custom tracker roots. Inherited receipts from another tracker
  namespace are removed. Untracked, missing, conflicted, malformed, or
  provenance-divergent sidecars remain untrusted; no source receipt, index,
  or history is written by verification. A failed source index/object read aborts
  snapshot setup before its receipt namespace is changed. A workspace without
  Git authority or without indexed receipts still supplies no durable proof.
  See [Faithful package acceptance](PACKAGE_GATE_ACCEPTANCE.md) for limits.
  Each existing root or nested `node_modules`
  directory is linked at its original relative path, including installations
  already represented by directory symlinks. This preserves independent
  monorepo dependency versions without copying dependency trees. Dependency
  aliases into excluded trees or included workspace source are refused. Internal
  shared targets must remain within admitted `node_modules` subtrees; external
  installations must be disjoint from the source workspace, rather than
  containing it. They remain available even when an external ancestor shares an
  excluded directory name.
  Links are read-only **by convention**; they do not prevent a trusted command
  from modifying the original installation. Use an independent installation
  when testing package-manager operations or dependency writes. Built output
  remains available so linked commands such as `node dist/cli.js` keep working.
  The source workspace root is resolved before copying. Ordinary file and
  directory symlinks into included workspace source are rebased into the copy,
  including dangling file aliases; writes through those aliases stay in the
  disposable snapshot. Targets are canonicalized through their nearest existing
  ancestor, so absolute aliases through another workspace path spelling and
  missing target suffixes retain the same isolation on supported platforms.
  Source aliases into unadmitted external directories or excluded tracker/build
  trees fail before the linked command runs. An alias into an admitted shared
  dependency namespace retains the dependency-write convention above, including
  packages linked within that installation. Source and snapshot destinations
  must be physically disjoint; overlapping roots fail before copying with a
  diagnostic directing the caller to a temporary root outside the checkout.

  Snapshot target probes treat only `ENOENT` as absence and propagate other
  filesystem failures. They use explicit error handling so Node 22 and older
  Node 24 releases retain the same dangling-link behavior; the async `stat`
  `throwIfNoEntry` option was added in
  [Node 24.15](https://nodejs.org/download/release/v24.20.0/docs/api/fs.html#fspromisesstatpath-options).
  The real filesystem and CLI snapshot suite runs on Node 22 in the required
  `Packed runtime (ubuntu-latest)` job and in the native Windows regression job
  before merge.

  Windows execution is tracked by [pm-bj7rq0](../.agents/pm/issues/pm-bj7rq0.toon).
  Script and native keeper cohorts run independently on Windows Node 24. Their
  source/script keeper steps retain the two-worker cap, and each cohort retains
  the 12-minute deadline. The four-file Git/worktree receipt slice uses one
  worker to avoid competing subprocess-heavy files at the same case deadlines. The required
  `Windows regression (Node 24)` check waits for both cohorts and fails if either
  fails, is cancelled, or is skipped. This preserves every selected regression
  while avoiding a shared serial job deadline. See GitHub's
  [job dependency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs#defining-prerequisite-jobs).

  The real point-read corpus keeper runs with the lifecycle latency keeper in
  the existing sequential performance phase after parallel contracts. Its
  1,500-item corpus, work-observer assertions and 30-second deadline remain
  unchanged. Standalone script identity is resolved from the test module URL,
  independently of temporary SDK working directories.

  The real-filesystem regression for this contract is tracked by
  [pm-5iwfkj](../.agents/pm/issues/pm-5iwfkj.toon).

Every result reports the requested/effective workspace mode, working
directory, exposed source root, and trust decision. Recorded `test_runs` retain
the effective workspace mode and trust reason beside the command.

## Linked-Test Command Trust

Linked commands are stored shell programs, so merge-unioned tracker data is an
execution boundary. New command entries record author, creation time, source
branch when available, and whether the item merge driver introduced the entry.
Locally created commands keep their previous run behavior. Commands marked as
merge-unioned or carrying a different source ref fail before process creation.
Malformed provenance is sanitized to the additive `provenance_invalid` marker
and receives the same fail-closed treatment; it is never normalized into a
trusted legacy command.
These pre-execution refusals use the `trust_refusal` failure category, separate
from command or assertion failures.

Command-string shape is intentionally not treated as a security boundary.
Direct `node --test`, Vitest, package-manager, shell-wrapped, and non-Node
runners are accepted consistently because the runtime injects tracker
isolation for all of them. `classifyLinkedTestCommandSafety` exposes the same
SDK policy to package hosts and returns advisory runner classification;
provenance review and acknowledgment remain the execution trust boundary.

Choose one explicit recovery:

```bash
# Review and trust the item's current command fingerprints in this clone.
pm test <item-id> --acknowledge-linked-tests

# Or permit a single reviewed run. Both controls are required.
pm config project set untrusted-linked-test-execution enabled
pm test <item-id> --run --allow-untrusted-linked-tests
```

Acknowledgments live in the clone-local ignored runtime directory and bind to
the full command, tracker/workspace context, environment controls, host-safety
mode, and provenance fingerprint; editing any of those fields requires a new
review. Enabling the project policy alone never executes
an untrusted command, and the per-run flag alone is also refused. Inspect all
unacknowledged entries without executing them with:

```bash
pm validate --check-command-references --verbose-diagnostics
```

Use explicit modes when needed:

```bash
pm test <item-id> --run --pm-context schema
pm test <item-id> --run --pm-context tracker
pm test <item-id> --run --pm-context auto --check-context --auto-pm-context
pm test <item-id> --add-json '{"command":"pnpm exec vitest run tests/integration/linked-test-context-trust.integration.spec.ts","pm_context_mode":"none","workspace_context_mode":"snapshot"}'
```

Command admission and positional recovery are tracked by
[pm-gh1555](../.agents/pm/issues/pm-gh1555.toon) and
[pm-t2dqzijokl31](../.agents/pm/issues/pm-t2dqzijokl31.toon).
Commands consisting only of assignments or shell comments, such as
`status=passed`, `RESULT=ok # note` or `RESULT=ok;`, are
refused with `linked_test_command_not_executable` before registration or
execution, including already-stored entries. They do not establish test-pass
evidence. Remove a legacy entry with `pm test <id> --remove-index <index>`,
then register the actual command. Environment assignments preceding a real
command remain supported on shells that accept that syntax, including commands
on a later line after a comment.
Assignment-only lists separated by `;`, `&&`, `||`, `|` or `&` also fail
admission. Quoted or escaped separators remain part of their assignment value;
the guard preserves lists containing an actual executable command.

A misplaced positional path on `files` or `docs` is refused with an explicit
`--add path=...` retry in `recovery.suggested_retry_args`; supplied values and
presentation options are preserved. A quoted positional test command receives
an explicit `--add-json` retry. Explicit `command=` or `cmd=` entries retain their
structured metadata through `--add`. An empty command or metadata alone, such
as `timeout_seconds=3600`, receives a template requiring the actual command, without a guessed executable
retry. Refused invocations do not modify the item.
Assignment/comment-only positional commands also receive templates instead of
retries that the registration guard would immediately refuse.
For legacy entries, `test-all` reports each refusal in its owning item's ordered
`run_results` with `failure_category: "config_refusal"`. Valid tests and later
items continue; refusals count as failures in aggregate and persisted summaries.

For complex linked-test commands, prefer JSON input so shell syntax survives unchanged:

```bash
pm test <item-id> --add-json '{"command":"node scripts/run-tests.mjs test -- tests/unit/output.spec.ts","timeout_seconds":240}'
```

To rerun a focused subset without editing linked-test metadata:

```bash
pm test <item-id> --run --match output
pm test <item-id> --run --only-index 2
pm test <item-id> --run --only-last
```

A selective run's receipt lists only the tests it selected. When the
receipt includes `tests_omitted`, copy and run the complete
`tests_omitted.restore_with` command to read the whole stored collection. It
keeps the invocation's `--pm-path` (including a tracker chosen through
`PM_PATH`) and `--no-extensions`, which a bare `pm test <item-id> --list` would
drop.

Linked-command stdout and stderr are captured through temporary regular files,
then read back with the 20 MiB per-stream retention bound. This keeps inherited
descriptors blocking for Bun, Rust, and other runtimes that treat `EAGAIN` on a
non-blocking stdout pipe as fatal. Output beyond the bound is drained to disk,
the child still completes normally, and the result records a truncation notice
instead of misclassifying a transport failure as a test assertion.

Strict governance flags:

```bash
pm test <item-id> --run \
  --fail-on-context-mismatch \
  --fail-on-skipped \
  --fail-on-empty-test-run \
  --require-assertions-for-pm
```

Structured quantitative evidence can be recorded and queried without parsing
logs or comments:

```bash
pm test <item-id> --run \
  --measure coverage=100,unit=percent,threshold=100 \
  --measure p95_latency=42,unit=ms,threshold=50
pm test <item-id> --metric-below coverage=100 --metric-diff p95_latency
```

Measurements are stored on the producing `test_runs` row, retained with the
bounded run history, and exposed consistently by CLI, SDK, MCP, and contracts.
Each recorded row also keeps a bounded `executions` list with the exact linked
command, requested/effective `pm_context_mode`, effective workspace mode, and
trust reason, so tracker-backed verification remains attributable after the
transient process logs are gone.

## Linked-Test Assertions

Tracked by [pm-test-measure-prerequisite](../.agents/pm/issues/pm-test-measure-prerequisite.toon):
`--measure` requires `--run`, as declared by CLI help and machine contracts.
A measurement-only request refuses before writing item or history data. Its
tokenized recovery preserves measurement values and run selectors and keeps
clone-local command trust enforced. Measurement evidence describes execution;
it cannot be added to an item without running its linked tests.

See [startup runner qualification](https://github.com/unbraind/pm-cli/blob/main/docs/performance/runner-qualification.md) (repository-only, excluded from npm) for the
independent control measurements retained by the SDK and CLI performance gates.

Linked tests can include assertion metadata:

```bash
pm test <item-id> --add \
  command="pm list --status open --json",timeout_seconds=120,assert_json_field_gte=count:0
```

Common assertion keys include:

- `assert_stdout_contains`
- `assert_stdout_regex`
- `assert_stderr_contains`
- `assert_stderr_regex`
- `assert_stdout_min_lines`
- `assert_json_field_equals`
- `assert_json_field_gte`

## Background Runs

```bash
pm test <item-id> --run --background
pm test-all --status in_progress --background
pm test-runs
pm test-runs status <run-id>
pm test-runs logs <run-id> --tail 100
pm test-runs stop <run-id>
pm test-runs resume <run-id>
```

Background run fingerprints prevent duplicate parallel runs for the same linked-test set.
For long `test-all` runs, `pm test-runs status <run-id> --json` includes the
latest aggregate item coordinates (`item_index`, `item_total`, `item_id`) plus
linked-test coordinates and `current_command` when the child emits progress.
Use `pm test-runs logs <run-id> --stream stderr` only when the compact status
message is not enough.

The bundled `pm-linked-test-adapters` package is the first-party package
exemplar for background run management. Install it in an isolated project when
validating package-provided test-run surfaces:

```bash
pm package install linked-test-adapters --project
pm package doctor --project --detail deep --trace
pm test-runs list --json
```

The package activates the `test-runs` command family and keeps subprocess
handling behind an explicit package permission declaration, so it is a useful
smoke target for package, permission, and command-contract changes.
