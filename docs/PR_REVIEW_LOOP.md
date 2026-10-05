# Pull Request Review Loop

Trackers: [pm-hq28](../.agents/pm/tasks/pm-hq28.toon), [pm-0fxa](../.agents/pm/tasks/pm-0fxa.toon), [pm-zpwfzy](../.agents/pm/issues/pm-zpwfzy.toon), [pm-cp5pbo](../.agents/pm/tasks/pm-cp5pbo.toon), [pm-8we38i](../.agents/pm/issues/pm-8we38i.toon)

Use `scripts/reviews/pr-review-loop.mjs` to inventory every GitHub pull-request
conversation surface before deciding that review is complete. The inventory includes
top-level comments, submitted reviews, inline review threads, edited timestamps,
reaction state, thread resolution, outdated markers, and the reviewed head SHA.

GitHub command responses have a 64 MiB transport bound and fail visibly on overflow;
an overflow never certifies a complete inventory. Acknowledgement lookups retain
every page but project only comment IDs, bodies, and reply-parent IDs before
capture, avoiding repeated diff hunks that are irrelevant to marker matching.

```bash
node scripts/reviews/pr-review-loop.mjs inventory --pr 123 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs watch --pr 123 --interval 30 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs react --node-id IC_kw... --reaction THUMBS_UP
node scripts/reviews/pr-review-loop.mjs acknowledge --pr 123 --node-id PRR_kw... --revision '<revision>' --reaction THUMBS_UP --body "CodeRabbit feedback implemented: https://github.com/owner/repo/pull/123#pullrequestreview-456. The suggested edge case is covered by test X."
node scripts/reviews/pr-review-loop.mjs reply-inline --pr 123 --comment-id 456 --body "Addressed in abc123."
node scripts/reviews/pr-review-loop.mjs acknowledge-inline --pr 123 --comment-id 456 --node-id PRRC_kw... --revision '<revision>' --reaction THUMBS_UP --body "Addressed in abc123."
```

Choose `THUMBS_UP` when feedback is useful or correct and `THUMBS_DOWN` when a
finding is materially incorrect. Use `acknowledge-inline` so the reaction and
explanation land on the actual review comment and its thread. GitHub does not expose
a reply thread for top-level PR conversation comments or submitted review summaries.
Use `acknowledge` for those surfaces: its PR comment must identify the bot, link the
exact GitHub artifact, and explain whether the feedback was implemented or declined.
That keeps the response auditable without pretending GitHub created a direct thread.
The command adds a hidden artifact marker and reuses an existing marked comment on
retry, so a lost response cannot create duplicate acknowledgements. It reports a
partial result and exits unsuccessfully when either the comment or reaction write
fails, allowing the missing write to be retried safely.

Each comment and review also carries a `revision`: a SHA-256 identity of its
body and review state. Compare these identities after each completed check watch
and immediately before merge. A changed body or review verdict needs fresh
triage even when its node ID already has an acknowledgement. Reaction timestamp
changes alone do not create a new revision. Pass the observed revision to both
`acknowledge` and `acknowledge-inline` with `--revision <revision>`; their hidden
markers then distinguish revised feedback and suppress duplicate retry replies
for that same revision. Inline markers are matched only within the selected
reply thread. Legacy calls without the flag retain their existing behavior.

After every push or reviewer retrigger, run `watch`. It delegates waiting to
`gh pr checks --watch`, because reviewer agents report completion through GitHub
checks, and only fetches the complete conversation inventory after those checks
finish. Native watch success covers emitted checks only: a required provider may
never emit its context. The helper unions classic branch-protection requirements
with all effective ruleset requirements, compares those names with the complete
head rollup, and records `mergeReadiness.requiredContexts`, `missingContexts`, and
GitHub's `mergeStateStatus`. An attempt is `passed` only when no required name is
missing and GitHub reports `CLEAN`. GitHub's merge state also retains enforcement
of expected check publishers and other merge requirements; a matching name alone
does not establish that its expected app passed. Missing contexts and blocked or
unknown merge state remain `incomplete`; native watch failures remain `failed`.
Superseded attempts never certify readiness. Unavailable policy or status reads
fail visibly instead of certifying readiness. Successful
coverage uploads alone cannot certify a downstream provider's patch status.
The direct `watch` command emits its complete JSON receipt before exiting `1`
for `incomplete` or `failed`, and exits `0` only for `passed`. Shell automation
can therefore stop on the exit status while retaining all findings for triage.

A failed reviewer check is still a completed review signal: `watch` records
the failed outcome and returns all findings instead of aborting before inventory.
If the PR head or target branch changes during the wait or final readiness read,
the helper watches the new target, up to three consecutive attempts, before
returning exact-head state. It does not poll an absent required provider status.
A review pass is complete only when every bot surface in that inventory has been
handled appropriately, every actionable thread is resolved, and required checks
have completed successfully.

Do not use timed sleeps or repeated inventory polling while hosted checks and bot
reviews run. Let `watch` block on the GitHub checks once, then act on the returned
`pullRequest.headRefOid`, check outcomes, comments, reviews, and review threads.
