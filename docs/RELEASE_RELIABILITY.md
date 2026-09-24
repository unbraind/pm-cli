# Scheduled release reliability

Tracked by [pm-e70zh5](../.agents/pm/issues/pm-e70zh5.toon) and
[pm-44u3wt](../.agents/pm/issues/pm-44u3wt.toon).

The **Release Reliability** workflow evaluates the preceding 30 days after a
scheduled Auto Release completes, daily at nominal 04:35 UTC, and on manual
dispatch. It saves a JSON report and fails its own check when policy is breached.
The report is independent of candidate correctness: historical failures must
remain visible while a reviewed repair can still pass publication gates.

## Policy and clock

[The versioned policy](../config/release-reliability-policy.json) declares the
nominal release cron as 02:35 UTC, a 60-minute dispatch allowance, a maximum
10% failure rate, and at least seven completed observations. These are explicit
operational targets, not thresholds fitted to make the current history green.
Missing samples yield an insufficient-data failure, never a healthy zero rate.

Dispatch delay measures `created_at` against the nearest preceding nominal
daily occurrence. Queue delay separately measures `run_started_at - created_at`.
GitHub does not supply the intended scheduled timestamp: the inferred occurrence
cannot disambiguate delays greater than 24 hours. Missing the latest occurrence
whose 60-minute allowance has elapsed produces `missing_scheduled_run`. Before
03:35 UTC, absence of today's run is still within the allowance; afterward,
inspect the report to distinguish missing dispatch, a pending attempt, and a
completed failure. A late run is visible even when it subsequently succeeds.

The release version and one-per-day guard use the UTC execution date captured
by release preparation, not the inferred cron occurrence. A delayed run cannot
backdate a tag. Reporting never creates, retargets, retries, or publishes a tag.
The unchanged [release recovery rules](RELEASING.md#failure-handling) apply.

## Evidence and denominator

The collector paginates the schedule-only runs API over an explicit half-open
UTC window and checks returned counts and unique IDs. It retrieves attempt 1
when a run was rerun. A later successful attempt, manual dispatch, issue recovery,
or closed blocker cannot change the original scheduled failure. Pending runs
are listed separately; all completed non-success conclusions count as failures.
API errors, truncated pages, ambiguous artifacts, and mismatched run identities
fail collection rather than silently reducing the denominator.

Auto Release saves `release-observation-<attempt>` artifacts for 90 days. Each
contains only run/attempt identity, event, outcome and failure-stage name. Gate
stdout, stderr, credentials and environment values are not archived. A confirmed
publication, verified existing same-day release, unchanged source, tracker-only
changes, and an empty changelog are distinct outcomes. Failed gates retain their
structured stage; older failures fall back to failed job/step names from GitHub.
Missing or expired success receipts are `unknown_success`, with
`outcome_evidence_complete: false`; success alone does not prove publication.

Reports retain the input policy, window, per-run observations, outcome counts,
stage counts, denominator, failure rate and violations. Download a report using
`gh run download <report-run-id> --name <artifact-name> --dir <temporary-directory>`.
The pure evaluator in `scripts/release/release-reliability.mjs` permits offline
replay with a fixed clock and captured input; the collector is read-only and
downloads only data, never executable source. The reporting workflow checks out
the default branch rather than the triggering run's code and has read-only token
permissions.

The report is a rolling observation, not a permanent archive of all releases.
Retain exported receipts externally if a longer historical window is needed.
It does not implement the separate nightly per-leg reliability programme or
change the manual same-day version policy.

Provider contracts: [workflow run attempts](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)
and [completion-triggered workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
