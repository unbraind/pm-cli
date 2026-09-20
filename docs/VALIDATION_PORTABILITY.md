# Completion portability and bounded replication checks

Tracked by [pm-t6jl1f](../.agents/pm/issues/pm-t6jl1f.toon) and
[pm-26y269](../.agents/pm/tasks/pm-26y269.toon).

## Bash completion data boundary

The public SDK completion renderer supports Bash 3.2, including the system Bash
on macOS. Static command choices, runtime schema flags, types, statuses, and
tags use the same literal prefix matcher. Generated source quotes static input
once; completion execution reads choices as data and appends quoted array
elements to `COMPREPLY`. Candidates containing shell metacharacters or Unicode
use portable single-quote syntax, including embedded quote escaping, so accepting
a candidate and pressing Enter also preserves its literal argument value.

Already quoted or backslash-escaped prefixes return no suggestions before optional
completion initialization can remove their quoting. This conservative boundary
avoids inserting an unquoted-context escape inside a different shell quoting
context. Normal unquoted prefixes retain literal matching.

The matcher never evaluates choices as shell programs. Dollar signs, backticks,
quotes, backslashes, and wildcard characters remain literal. Unicode survives
both byte-oriented and UTF-8 locales. A wildcard in the typed prefix is also
literal, and an unmatched prefix returns no choices. Namespace and annotation
completion may append additional matches without discarding earlier matches.

The package output adapter recognizes both canonical `completion types`,
`completion statuses`, and `completion tags` paths and their compatibility
aliases. These helpers emit plain words by default; explicit `--json` retains
structured results. Installed-command acceptance verifies this wire boundary.

The existing helper protocol is whitespace-delimited: spaces, tabs, and newlines
separate candidate words. This change does not introduce a new representation
for candidate values containing whitespace. Helper lookup, fallback choices,
and cache policy retain their existing contracts.

`compgen -W` cannot safely serve as the data transport here: it performs another
expansion pass, and Bash 3.2 does not round-trip the ANSI-C quoting emitted by
`printf %q` for Unicode. Unquoted command-substitution arrays can additionally
expand literal wildcard candidates into filenames. The regression executes the
generated function and parses its accepted words with the real Bash parser,
rather than inferring safety from source substrings.

Run the focused native regression after building:

```bash
node scripts/run-tests.mjs test -- tests/unit/sdk/security/completion-search-boundaries.spec.ts
```

To test another installed Bash version, set `PM_COMPLETION_TEST_BASH` to its
executable path. This is a test harness input, not a CLI configuration setting.
The existing macOS runtime-smoke job pins `/bin/bash` so PATH cannot silently
substitute a newer Homebrew Bash. It runs this regression before merge; Linux
coverage runs the same matrix. Native Fish and Zsh acceptance remains in the
required smoke gate.

## Replication diff collection

The replication gate retains a complete changed-path census across committed,
staged, unstaged, deleted, and untracked paths. Whole-file triggers and required
member checks consume that complete census.

Only structured triggers declaring `changed_lines_contain_any` need patch
content. The collector deduplicates their declared paths and reads patches only
for changed paths in that set. With a merge base, one such path requires three
patch subprocesses regardless of how many unrelated tracker documents changed.
No content triggers means no patch subprocesses.

Every applicable patch layer must be readable before its content can deactivate
a trigger. If one layer fails, evidence for that path is unknown even when
another layer contains readable but unrelated hunks. Unknown evidence activates
the trigger. Untracked files and empty patches retain that conservative policy;
deleted files remain visible through removed lines and the full path census.

```bash
node scripts/run-tests.mjs test -- tests/unit/scripts/release/surface-replication-cost.spec.ts tests/unit/scripts/release/surface-replication-gate.spec.ts
```

The cost regression uses an actual temporary Git repository with 1,000 unrelated
files. Git's trace records the real patch process count. A separate injected
staged-patch read failure proves the unknown-evidence boundary without replacing
the other Git operations or filesystem reads.
