# Pull Request Review Loop

Tracker: [pm-hq28](../.agents/pm/tasks/pm-hq28.toon)

Use `scripts/reviews/pr-review-loop.mjs` to inventory every GitHub pull-request
conversation surface before deciding that review is complete. The inventory includes
top-level comments, submitted reviews, inline review threads, edited timestamps,
reaction state, thread resolution, outdated markers, and the reviewed head SHA.

```bash
node scripts/reviews/pr-review-loop.mjs inventory --pr 123 > /tmp/pr-123-review-inventory.json
node scripts/reviews/pr-review-loop.mjs react --node-id IC_kw... --reaction THUMBS_UP
node scripts/reviews/pr-review-loop.mjs reply-inline --pr 123 --comment-id 456 --body "Addressed in abc123."
node scripts/reviews/pr-review-loop.mjs reply-top --pr 123 --body "Acknowledged; no code change because ..."
```

Choose `THUMBS_UP` when feedback is useful or correct and `THUMBS_DOWN` when a
finding is materially incorrect; explain either decision in the relevant inline
thread when GitHub exposes one, otherwise use a top-level reply that identifies the
review or comment. Re-run the inventory after every acknowledgement batch and after
every pushed commit. A review pass is complete only when all bot comments and
reviews on the current head have a reaction and an explanatory reply, every
actionable thread is resolved, requested bots have returned, and all required
checks have completed successfully.

For long-running hosted checks and bot reviews, start one bounded wait command and
let it finish instead of repeatedly polling. After the wait, compare
`pullRequest.headRefOid` with the pushed commit before acting on the inventory.
