# Pull Request Review Loop

Trackers: [pm-hq28](../.agents/pm/tasks/pm-hq28.toon), [pm-cp5pbo](../.agents/pm/tasks/pm-cp5pbo.toon)

Use `scripts/reviews/pr-review-loop.mjs` to inventory every GitHub pull-request
conversation surface before deciding that review is complete. The inventory includes
top-level comments, submitted reviews, inline review threads, edited timestamps,
reaction state, thread resolution, outdated markers, and the reviewed head SHA.

```bash
node scripts/reviews/pr-review-loop.mjs inventory --pr 123 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs watch --pr 123 --interval 30 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs react --node-id IC_kw... --reaction THUMBS_UP
node scripts/reviews/pr-review-loop.mjs acknowledge --pr 123 --node-id PRR_kw... --reaction THUMBS_UP --body "CodeRabbit feedback implemented: https://github.com/owner/repo/pull/123#pullrequestreview-456. The suggested edge case is covered by test X."
node scripts/reviews/pr-review-loop.mjs reply-inline --pr 123 --comment-id 456 --body "Addressed in abc123."
node scripts/reviews/pr-review-loop.mjs acknowledge-inline --pr 123 --comment-id 456 --node-id PRRC_kw... --reaction THUMBS_UP --body "Addressed in abc123."
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

After every push or reviewer retrigger, run `watch`. It delegates waiting to
`gh pr checks --watch`, because reviewer agents report completion through GitHub
checks, and only fetches the complete conversation inventory after those checks
finish. A failed reviewer check is still a completed review signal: `watch` records
the failed outcome and returns all findings instead of aborting before inventory.
If the PR head changes while checks are running, the helper automatically watches
the new head, up to three consecutive attempts, before returning exact-head state.
A review pass is complete only when every bot surface in that inventory has been
handled appropriately, every actionable thread is resolved, and required checks
have completed successfully.

Do not use timed sleeps or repeated inventory polling while hosted checks and bot
reviews run. Let `watch` block on the GitHub checks once, then act on the returned
`pullRequest.headRefOid`, check outcomes, comments, reviews, and review threads.
