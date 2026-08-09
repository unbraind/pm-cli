# Sentry Error Contract Epochs

Tracker reference: [pm-h75tjh](../.agents/pm/issues/pm-h75tjh.toon).

The release reliability gate declares `2026.8.7` as the minimum producer
version for canonical `pm.error_code` and `pm.exit_code` tags. An unresolved
event with a known older release is reported as `legacy_pre_contract`; it does
not block a current release merely because it cannot satisfy a future
producer contract.

Events from the minimum producer or newer remain blocking when they are
unexpected faults or lack the required tags. Events with no parseable producer
version are also blocking. JSON output includes the minimum version,
`legacy_pre_contract_total`, bounded legacy ids, and a bounded blocking-reason
row for each current issue. Expected handled usage, not-found, and conflict
errors remain a separate non-blocking class.

This epoch rule only changes gate classification. It does not resolve, delete,
or hide Sentry issues, and it does not weaken fatal or error thresholds for
current producers.
