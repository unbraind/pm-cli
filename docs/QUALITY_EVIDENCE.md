# Test strength and documentation content

Tracked by [pm-zclzll](../.agents/pm/tasks/pm-zclzll.toon) and
[pm-dvwm](../.agents/pm/chores/pm-dvwm.toon).

## SDK mutation testing

`pnpm quality:mutation` uses Stryker's Vitest runner to mutate the SDK cursor and
external-dependency primitives. The declared partition in
`scripts/release/sdk-mutation.json` is deliberately bounded. It does not claim
a mutation score for the entire SDK. The existing behavioral tests run without
retries; no production functions are mocked in this partition. All-source
coverage remains a separate mandatory 100/100/100/100 gate.

The sandboxed runner creates external temporary project/global trackers,
disables external telemetry, removes ambient source-workspace references, and
copies mutation sources without the real tracker. It holds the build lease
until the engine exits and removes the owned temporary directory afterward.
The normal source tree is never mutated. Every run executes all mutants;
incremental results cannot supply stale evidence. Four workers and per-mutant
timeouts bound this partition inside the existing 20-minute static job.
The runner fixes sandboxing, fresh execution and the complete mutator set after
loading configuration, so configuration overrides cannot disable those controls.

The gate verifies source bytes, exact module scope, nonempty mutant populations,
and unique mutation identities. Only assertion-killed mutants contribute to the
raw score. Timeouts, compiler errors, uncovered mutants and ignored mutants fail.
A survivor requires an exact identity, a behavioral equivalence explanation,
and an owning pm item in `sdk-mutation-baseline.json`. The initial seven waivers
cover redundant guards and JavaScript serialization and absent-date equivalences;
there are no blanket mutator exclusions or source-ignore directives.

Inspect `.cache/mutation/report.json` for individual mutations and
`.cache/mutation/receipt.json` for the gate verdict. On a new survivor, first add
a behavioral assertion to the existing test that owns the contract. If the
mutation is observably equivalent, record its exact identity and justification
for review. Remove waivers that disappear or become killed. Improvements require
raising `minimumScore`; CI compares the floor and module scope with the PR base
and refuses regression. Do not round the score when updating the baseline.

Both `pnpm quality:static` and the existing required hosted static job run the
partition, as do nightly and release static validation. The runner rejects
command-line mutation overrides. Extending the partition requires adding the
module and its behavioral tests together, measuring runtime, and reviewing every
survivor. Gate unit tests inject report/engine boundaries to prove failure paths;
the actual Stryker execution is an additional required gate.

## Documentation content ratchet

`pnpm quality:docstrings` parses documentation comments across runtime sources,
packages, scripts, plugins and executable examples. It detects four known filler
templates, including wrapped comments, without matching quoted strings or
ordinary comments. Module, exported-declaration and member documentation coverage
remain independently enforced by the existing static gate.

The initial census found 4,192 filler comments. This delivery removes ten from
the Commander alias contract and records the remaining per-file counts. The
remaining debt is visible; an enforced inventory is not a claim that every
existing comment is now informative.

When editing a declaration, replace its filler with the actual behavior,
precedence, units or invariants. Do not merely restate the identifier. After
reducing a file's count, run `pnpm quality:docstrings:update` and commit the
smaller baseline. The update refuses growth, including in new files. Counts
cannot be traded between files, and CI refuses baseline increases against the
PR base via `PM_QUALITY_BASE_REF`. Removed filler cannot silently return by
leaving a stale larger ceiling.
