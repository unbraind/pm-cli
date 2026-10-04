# Agent evidence consistency

Trackers: [pm-gh1383](../.agents/pm/issues/pm-gh1383.toon),
[pm-gh1385](../.agents/pm/issues/pm-gh1385.toon), and
[pm-7wzc6f](../.agents/pm/issues/pm-7wzc6f.toon). Distribution verification:
[pm-2evidence-dist](../.agents/pm/issues/pm-2evidence-dist.toon).

## Agent quick context

Evidence must retain its literal text, validation must compare a consistent
item/history pair, and recovery help must identify a declared command. These
contracts apply to ordinary project work and to the evidence used for recursive
self-improvement.

## Literal annotations

`comments`, `notes`, and `learnings` preserve positional annotation bodies through
bootstrap normalization. A prefix such as `TDD:` or `add:` is evidence text.
The same text is preserved when supplied through `--add`, `--file`, `--stdin`,
`--add -`, or `--file -`.

```bash
pm comments <id> "TDD: regression reproduced before the fix"
pm notes <id> --file evidence.txt
pm learnings <id> --stdin
```

The annotation SDK still supports its explicit `text:` and `text=` structured
input syntax. Files and standard input remain literal text sources. Other
commands retain their supported bare-key option normalization.

## Consistent history validation

Validation first scans the captured corpus. An ordinary writer can advance an
item and its history after that capture. An item-hash discrepancy is therefore
read again while holding the same item mutation lock used by ordinary writers.
This fresh source/history pair determines the finding. A reread whose declared
identity differs from the locked identity fails before any finding is replaced.

Clean rows and history-only findings do not incur another item read or lock
acquisition. Each item-hash discrepancy gets one bounded recheck. Lock contention
and missing or unreadable item source are reported as failures; validation does
not steal locks or certify an unread pair.
Missing histories, malformed streams, record-chain corruption, unsupported
epochs, and identity discontinuities retain their strict findings. History-only
diagnostics remain available to repair workflows even when a writer owns the item.
Workspace singleton findings retain their own verification semantics.

The core `scanHistoryDrift` API continues to compare the snapshots supplied by
its caller. Its strict `scanItemHistoryDrift` companion shares stream verification
without loading or writing the corpus cache or rereading workspace history and
governed documents. Workspace checks run once in the initial corpus scan.

## Declared recovery help

An unknown option has no declared value arity. In an invocation such as
`pm --unknown-option synthetic-value context`, the parser cannot safely assume
that `synthetic-value` is a command. Recovery falls back to `pm --help --all`
unless the inferred target belongs to the core or active runtime command surface.
Known commands, command-first invocations, namespaced aliases, and options with
an equals value retain command-specific recovery help.

## Verification

The regression owner exercises real isolated tracker persistence, all annotation
transports, strict corruption cases, writer-lock contention, cache preservation,
identity binding, bounded cache reads, and public bootstrap normalization:

```bash
node scripts/run-tests.mjs test -- tests/unit/regressions/agent-evidence-consistency.spec.ts
node scripts/release/agent-evidence-consistency-control.mjs
node scripts/release/agent-evidence-consistency-control.mjs --negative-control
```

The final command must exit with status `1`: each disposable source mutation
must fail its selected regression. A failure caused by unrelated setup is not
accepted as regression proof.

Build finalization also compacts redundant syntax in retained runtime modules.
Exported names, module paths, declarations, bundled files and original source
maps remain covered by real filesystem and Node consumer tests. The npm artifact
must satisfy its existing size ceiling before installed npm/npx/bunx acceptance.

Packed SDK continuation acceptance stages the actual publish selectors and
unchanged package manifest in a disposable source directory before invoking
`npm pack`. This avoids traversing development dependencies while retaining
the real tarball, public SDK export, and existing process and test time limits.
Installed package smoke acceptance separately verifies dependency installation.
