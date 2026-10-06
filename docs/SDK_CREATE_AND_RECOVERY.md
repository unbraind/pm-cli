# Item creation and agent recovery

Tracked by [pm-gh1400](../.agents/pm/issues/pm-gh1400.toon),
[pm-gh1413](../.agents/pm/issues/pm-gh1413.toon),
[pm-flfk2d](../.agents/pm/tasks/pm-flfk2d.toon), and
[pm-f05lsg](../.agents/pm/features/pm-f05lsg.toon).

Creation, refusal guidance, and read continuation belong to the SDK. CLI and
package consumers use those contracts to preserve project context across retries.

## Deterministic creation conflicts

Creating an existing ID refuses the write with conflict exit code `4` and stable
code `item_already_exists`. The original item and history remain intact. The
error's `context.id` identifies the canonical existing item; `context.path` is
its actual persisted document path, including its existing type folder.

Both `@unbrained/pm-cli/sdk` and `@unbrained/pm-cli/sdk/core` export
`isItemAlreadyExistsError` and `PmItemAlreadyExistsError`. The guard uses the
public error shape, code, exit class, and identity coordinates across separately
bundled packages. It does not depend on message wording or internal class identity.

```ts
import { PmClient, isItemAlreadyExistsError } from "@unbrained/pm-cli/sdk/core";

const client = new PmClient({ pmRoot: trackerRoot });
try {
  await client.create({
    id: "work-deploy-service",
    type: "Task",
    title: "Deploy the service",
    createMode: "progressive",
  });
} catch (error: unknown) {
  if (!isItemAlreadyExistsError(error)) throw error;
  const existing = await client.get(error.context.id);
  // Compare the existing intent and evidence before choosing reuse or an update.
  console.log(existing.item);
}
```

Concurrent creates of the same ID have one successful writer. A losing writer
receives the existing item's identity. This is a refusal contract; it does not
silently treat different create inputs as equivalent. Ownership, policy, and
similarity refusals retain their distinct semantics. Generated-ID allocation
continues to use its existing collision checks.

## Strict creation and actionable recovery

Required author identity accepts the same resolved actor used for mutation
history: explicit input, `PM_AUTHOR`, configured default, or detected harness.
Unknown fallback identity does not satisfy an omitted required author. A disabled
author-input policy still rejects explicit `--author`; automatic resolution does
not change that policy check.

Recovery examples use canonical executable flags, while diagnostic field labels
may list aliases. Required collection examples use `--clear-*` to express an
honestly empty collection. Replace scalar example placeholders with real project
values. A type without a configured status default still requires explicit status
under a strict status policy.

An explicit `claim <id> --start` cannot combine with `--next` or `--if-available`.
The refusal identifies that incompatibility without suggesting the rejected
selection flags as missing requirements. Remove both selection controls, retain
the item and remaining inputs, and retry. No automatic retry is supplied for this
ambiguous selection request.

Non-interactive initialization with missing guidance preserves the scoped
`init --agent-guidance status` and `init --agent-guidance add` actions in its compact
display. Inspection leaves user-authored guidance unchanged. Installation requires
the explicit add command; an explicit skip or previous decline is preserved.

## Amount limits and producer cursors

For list and search, an advertised producer cursor resumes after the last row
actually delivered, even when `--output-limit` caps a larger producer page and
the token budget does not bind. Serialized SDK, CLI, and packed consumers share
the same cursor coordinates.

Field selection preserves that boundary: `--output-include title` keeps IDs out
of returned rows while the cursor still identifies the last delivered source row.
Token-budget replay of a terminal page retains the number of rows already
delivered, including in positional recovery after a cursor row is deleted.

An explicit amount cap on a terminal producer page can report `has_more: true`
without manufacturing a producer cursor. This is a deliberately partial read.
To retrieve its withheld tail, repeat the same producer boundary with a larger
or unbounded output limit. A token-budget continuation retains its separate
`--output-cursor` recovery contract. See [Universal Read Output Contracts](READ_OUTPUT_CONTRACTS.md).
