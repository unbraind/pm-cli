# @unbrained/pm-vcs

> Tracker: [pm-xtrd](../../.agents/pm/features/pm-xtrd.toon), acceptance story [pm-8ngt](../../.agents/pm/stories/pm-8ngt.toon), atomic SDK transactions [pm-4e12](../../.agents/pm/features/pm-4e12.toon), graph SDK [pm-ju83](../../.agents/pm/features/pm-ju83.toon).

`pm-vcs` is the first deliberately non-project-management package in the
first-party ecosystem. It proves that public pm SDK and extension contracts can
model a small version-control domain without importing `src/core`, reading item
files directly, or adding VCS policy to the core CLI.

The exemplar provides:

- `Changeset` and `VcsRef` custom item types;
- `draft -> proposed -> merged|abandoned` domain lifecycle;
- `vcs ref-create`, `vcs create`, `vcs propose`, `vcs merge`, `vcs abandon`,
  `vcs show`, and `vcs log` commands;
- a `beforeCommand` hook enforcing explicit reviewed-merge affirmation;
- point-in-time changeset reconstruction through `getItemAt`;
- a durable, optimistic, append-only `commits_to` relationship stream projected
  through `RelationshipEventStore.project`;
- a crash-resumable `commitWorkspaceTransaction` merge that coordinates item
  lifecycle and relationship events with append-only compensation.

## Install and stage the domain

```bash
pm install vcs --project
pm profile apply vcs
pm package doctor --project --isolated --detail deep --json
pm contracts --command "vcs merge" --flags-only --json
```

The package registers live types and fields globally, so the manifest does not
use narrow command activation. Applying the profile stages custom statuses and
the `Changeset` transition graph idempotently.

## End-to-end changeset flow

```bash
pm vcs ref-create main --author demo
pm vcs create "Add durable projection" --ref <ref-id> --tree-hash sha256:abc --author demo
pm vcs propose <changeset-id> --author demo
pm vcs show <changeset-id> --at 1
pm vcs merge <changeset-id> --ref <ref-id> --reviewed --author demo
pm vcs log
```

`vcs show --at` reconstructs immutable item history. `vcs log` independently
projects the package-owned relationship JSONL stream, proving that current item
state and graph event state are both rebuildable from public SDK contracts.
`vcs merge` publishes success only after its SDK transaction journal commits;
ordinary failures compensate in reverse order, and retrying the same merge id
resumes any interrupted forward or compensation phase.

## Package boundary

All runtime imports use `@unbrained/pm-cli/sdk`. The exemplar intentionally does
not implement content-addressed object storage, a working tree, filesystem
diffing, or a network protocol. Those are Git product features; this package
tests the reusable context, lifecycle, history, graph, package, and policy
primitives beneath them.

See [GAP_REPORT.md](GAP_REPORT.md) for the concrete primitive assessment.
