# Full-history release reconciliation

Owner: [pm-q91qyd](../.agents/pm/issues/pm-q91qyd.toon).
Upstream trigger evidence: [pm-prrlce](../.agents/pm/issues/pm-prrlce.toon).

The Release Reliability workflow compares every dated section in the
package-generated changelog, every release tag advertised by `origin`, and
every version in anonymous public npm metadata. It runs on the existing daily
schedule and completion triggers, even when a rolling reliability report fails.
Its separate `release-ledgers-<run>-<attempt>` artifact contains the complete
input inventories, counts, findings and exception dispositions for offline replay.

Missing public registry versions are declared-but-undelivered releases. Missing
changelog sections are delivered-but-undocumented releases. A tag missing its
section is tagged-but-unsectioned; an identity can belong to several classes.
Every missing ledger appears explicitly in the report, without counting one
identity several times or dropping overlapping classes.
The `classes` object names these three populations separately; `findings`
retains one row per discrepant identity.

The first complete census on 2026-10-10 found 14 discrepant identities among
143 sections, 151 tags and 143 public versions. The exact historical signatures
and their individual dispositions are recorded in
[the reviewed exception policy](../config/release-ledger-exceptions.json).
Unpublished historical preparations are retained as abandoned publications;
historical documentation gaps remain visible without inventing shipped content.
These are explicit exceptions, not claims that the three historical sets agree.
No tag is deleted and no old artifact is published by this reporting path.

An exception matches one identity and one exact missing-ledger signature.
Additional missing evidence invalidates it. Correcting a historical gap makes
its exception stale and requires removing or revising that policy entry in a
reviewed change. A new discrepancy or stale exception fails the report.
Empty total inventories, incomplete populations, duplicate identities, malformed
remote output, registry failures and missing exception evidence refuse evaluation.

The registry request uses the same public npm metadata surface as release
acceptance, with explicit public registry selection, empty user/global
configuration and a fresh temporary cache. It runs outside the checkout and
removes inherited npm authentication/configuration. The report never archives
credentials, command output or environment values.
The parser supports npm 11's object and npm 12's single-result array, with
[captured public npm 12 metadata](../tests/fixtures/release-ledgers/npm-view-12.json)
as its format regression. Multiple package results refuse evaluation.

To run the actual collector after building:

```bash
RELEASE_LEDGERS_OUTPUT=/absolute/report.json node --input-type=module -e '
  import { main } from "./scripts/release/collect-release-ledgers.mjs";
  const report = main();
  console.log(JSON.stringify({ok:report.ok,counts:report.counts,findings:report.findings}));
  process.exitCode = report.ok ? 0 : 1;
'
```

Packages and non-release projects can use the same pure SDK primitive with
their own named artifact inventories and decision references:

```ts
import { reconcileArtifactLedgers } from "@unbrained/pm-cli/sdk/governance";

const report = reconcileArtifactLedgers([
  { name: "declared", complete: true, identities: ["artifact-1"] },
  { name: "delivered", complete: true, identities: ["artifact-1"] },
]);
```

`ArtifactLedgerSnapshot`, `ArtifactLedgerException`, `ArtifactLedgerFinding`
and `ArtifactLedgerReport` describe this harness-independent contract.
The evaluator performs no filesystem, clock or network operations and preserves
caller inputs. For offline replay, feed the saved `snapshots` and `exceptions`
back into `reconcileArtifactLedgers`.

## Tag-carried trigger declarations

New preparations create annotated tags whose bounded JSON message binds the
declared upstream event/origin, repository, run/attempt, reviewed source commit
and prepared target commit. Before publication, the Release workflow checks
the tag's peeled commit and source ancestry and compares the source declaration
with the exact GitHub run attempt, including repository, event, source SHA and
the producer workflow path and declared Auto Release run name. A mismatch
stops before publication.

The separate `release-publication-origin-<run>-<attempt>` artifact retains the
tag-object SHA, upstream declaration, independent verification result and the
current publication/recovery trigger. An operator recovering a dispatcher
release therefore retains both origins. A rejected atomic push can rebase and
rebind only the unpublished tag's target while preserving its original source.

Historical lightweight tags and unrelated legacy annotations stay explicitly
unattributed. No origin is inferred from a tag-push event or actor. Local
preparation records an operator declaration but cannot claim GitHub source-run
verification. Tag objects are content-addressed evidence; this does not assert
that GitHub release/tag immutability policy has been enabled.

The downstream tag-push workflow's run name still names `tag_push`; its verified
upstream origin lives in the summary and artifact. The remaining run-name and
operator-only manual follow-up contracts retain their existing owners
[pm-prrlce](../.agents/pm/issues/pm-prrlce.toon) and
[pm-uenmu9](../.agents/pm/issues/pm-uenmu9.toon). The one-automatic-release-per-UTC-day
guard and exact-tag recovery semantics are unchanged.

## Installed acceptance path cost

Owner: [pm-release-acceptance-path-cost](../.agents/pm/issues/pm-release-acceptance-path-cost.toon).

The disposable installed-consumer layout uses concise directory names because
`init` repeats its workspace path throughout its complete JSON guidance. Long
macOS temporary ancestry previously made an otherwise valid public artifact
exceed the raw 12,000-character init ceiling. Shorter private paths retain every
output field, lifecycle assertion, deadline and ceiling. The
[captured public output regression](../tests/fixtures/release-acceptance/README.md)
checks the raw cost for independent control/candidate local npm, global npm and
Bun layouts; actual installed sessions remain separate acceptance evidence.
