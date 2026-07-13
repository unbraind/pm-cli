# Pull Request Review Loop

Tracker: [pm-hq28](../.agents/pm/tasks/pm-hq28.toon)

Use `scripts/reviews/pr-review-loop.mjs` to inventory every GitHub pull-request
conversation surface before deciding that review is complete. The inventory includes
top-level comments, submitted reviews, inline review threads, edited timestamps,
reaction state, thread resolution, outdated markers, and the reviewed head SHA.

```bash
node scripts/reviews/pr-review-loop.mjs inventory --pr 123 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs watch --pr 123 --interval 30 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs react --node-id IC_kw... --reaction THUMBS_UP
node scripts/reviews/pr-review-loop.mjs reply-inline --pr 123 --comment-id 456 --body "Addressed in abc123."
node scripts/reviews/pr-review-loop.mjs acknowledge-inline --pr 123 --comment-id 456 --node-id PRRC_kw... --reaction THUMBS_UP --body "Addressed in abc123."
```

Choose `THUMBS_UP` when feedback is useful or correct and `THUMBS_DOWN` when a
finding is materially incorrect. Use `acknowledge-inline` so the reaction and
explanation land on the actual review comment and its thread. GitHub does not expose
a reply thread for top-level PR conversation comments or submitted review summaries;
react to those surfaces, but do not create a generic PR comment that pretends to be
a direct reply. The complete inventory keeps those non-threadable surfaces visible.

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
