# Changelog

## Unreleased

### Added

- Assurance presets and self-derivation: a new workspace acquires a working quality contract in one command, seeded from its own record rather than from a generic template ([pm-m7bb7r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m7bb7r.toon))
- Measurement provider API: extensions contribute measurement sources, so a coverage percentage, a benchmark millisecond, an eval score, an RL episode reward, or a registry dist-tag is bounded on the same terms as an item count ([pm-uhv1m5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-uhv1m5.toon))

### Fixed

- The relationship graph's only automated reader is a nine-field census with no structural property, so the deepest enforceable statement about an 11,291-edge record is that every active item has two edges ([pm-4vz6mz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4vz6mz.toon))
- The measurement ratchet has a single polarity: a filed number can only be enforced as a ceiling, so no quality floor this project wants to hold is expressible ([pm-g4k74y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g4k74y.toon))
- Telemetry flush reliability: configurable cold-connect timeout without foreground blocking ([pm-pmwozm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pmwozm.toon))
- The real all-package install is budgeted in one of its two instances, so the coverage gate flakes and then reports no coverage verdict at all ([pm-h9gsix](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h9gsix.toon))
- Absence-tolerant readers accept only ENOENT, so a tracker root that is a regular file raises an unclassified fault instead of the typed refusal the guard already owns — and that fault blocks the daily release ([pm-6xlyss](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6xlyss.toon))
- Mixed linked-resource remove and add in one command silently favors removal ([pm-c6urop](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c6urop.toon))
- Global flags before a subcommand corrupt guided-error command examples by treating the flag value as the command ([pm-lph0y6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lph0y6.toon))

### Other

- ADR: Lifecycle-sensitive graph partitions are advisory; stable all-status outcomes carry blocking assurance ([pm-dczodv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-dczodv.toon))
- The Windows nightly leg cannot separate product defects from harness noise: 744 hardcoded POSIX path literals and 203 raw errno strings in the suite fail on Windows for reasons unrelated to pm behaviour ([pm-j668gl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-j668gl.toon))

## 2026.8.12 - 2026-08-12

### Fixed

- Read-output session receipts can emit an invalid next_state after the served-item set crosses its own 10,000-ID input ceiling ([pm-b0v8fs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b0v8fs.toon))
- Linked pm test children inherit production Sentry environment and turn sandbox failures into release-blocking incidents ([pm-9aaji6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9aaji6.toon))
- SDK entrypoint import-cost gate false-fails on cold filesystem cache: single-shot fresh-process sampling exceeds the 30ms noise margin ([pm-cg1sjb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cg1sjb.toon))
- Legacy invalid provenance findings block health without a safe disposition path ([pm-5q8wa0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5q8wa0.toon))
- History drift scan hashes reordered linked-test projections ([pm-eax4y8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eax4y8.toon))
- Linked-test removal must be lossless and observable for commands containing comma or equals delimiters ([pm-m0b7h8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m0b7h8.toon))
- Annotation transposition recovery: detect pm <collection\> add <id\> before the item id is consumed as text ([pm-rncuf7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rncuf7.toon))
- Health result contract parity: every checks\[\] row exposes a boolean ok beside its tri-state status ([pm-h97qxd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h97qxd.toon))
- The relationship ratchet bounds every edge kind that carries meaning and leaves the one kind that carries none unbounded, so the cheapest way to satisfy every graph guarantee is to add edges no algorithm can traverse ([pm-q6n8sj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-q6n8sj.toon))
- Assurance registry mutations and gate verdicts record author unknown while carrying the full detected provenance in the same entry, so the audit artifact fails the question it exists to answer ([pm-33mjrw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-33mjrw.toon))
- Two assurance measurement sources answer from a projection that omits the fields they read, so a completeness gate reports zero missing evidence on a workspace with 874 items lacking it ([pm-py7qv2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-py7qv2.toon))
- Assurance mutation refusals cross the CLI as unclassified Sentry faults (PM-CLI-2Y/2Z/30) ([pm-v0a0un](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v0a0un.toon))
- GH-976: version history hashes so repeated tests_add streams verify across supported pm versions ([pm-2htk4p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2htk4p.toon))
- GH-975: export isAlreadyClaimedError through a supported SDK subpath ([pm-hfqju5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hfqju5.toon))
- GH-974: merge receipt preferred contradicts retained side under stable_value_order ([pm-qckpnq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qckpnq.toon))
- GH-971: health preflight collision diagnostics ignore declared command ownership ([pm-zryb9d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zryb9d.toon))
- GH-969: brief item reads can exceed standard output because omission receipts bill empty fields ([pm-gok2km](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gok2km.toon))
- GH-970: repeated row contracts consume half of agent read output without a suppression contract ([pm-gjjurs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gjjurs.toon))
- The output encoding named toon has no tabular array form, so every row collection pays three to five lines per row while the storage format beside it uses the encoding correctly ([pm-5y05kq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5y05kq.toon))
- pm activity answers what happened to one item in the last half hour when the agent asked what changed in the workspace: 20 rows cover 5 of the 272 items touched in 24 hours and none carries a title ([pm-j1r8gl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j1r8gl.toon))
- pm stats default output is dominated by rows that carry no information: 7 of 17 type buckets are zero, the status split agents actually need is missing, and the row contract costs more than the data ([pm-7nqo6b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7nqo6b.toon))

### Other

- Evaluate and refresh @sentry/node 10.70 with packed-consumer proof ([pm-fb0lkg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fb0lkg.toon))
- Refresh compatible tsx 4.23.12 and esbuild 0.28.2 patches ([pm-67b84b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-67b84b.toon))

## 2026.8.11 - 2026-08-11

### Added

- pm gate: named assertion bundles bound to lifecycle triggers, returning one structured verdict document instead of prose, so local and hosted enforcement run identical semantics ([pm-wn6wot](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-wn6wot.toon))
- Assurance verdicts are appended to the immutable record, so what was enforced when, and who relaxed a bound, is replayable and provable rather than reconstructed from CI logs ([pm-91xeam](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-91xeam.toon))
- pm assert: a bound over a measurement carrying polarity, scope, lifetime, enforcement level, and a required negative control, so every guarantee states which direction it can fail in ([pm-lyfu7b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-lyfu7b.toon))
- pm measure: a named population over the workspace declared as data, with a composable source vocabulary and derived arithmetic so a bound can be denominated in the unit it actually means ([pm-2lex4r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2lex4r.toon))
- Refusal reachability: every error code declares the states it owns, and an entrypoint-level probe proves each state is still reachable as that typed code rather than as an untyped fault ([pm-elmpav](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-elmpav.toon))
- Source-to-item traceability: derive which tracked work produced any given file or line, so an agent can ask why this code exists and get an evidence-backed answer ([pm-f86lth](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f86lth.toon))
- Automatic semantic session attribution: infer bounded topic and role from claimed work and harness context without per-call identity flags ([pm-3zgh2c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3zgh2c.toon))

### Fixed

- Unknown-option recovery names three of six commands that accept the flag, capped silently and in arbitrary order, so the hint excludes the right answer while reading as exhaustive ([pm-yqe0mo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yqe0mo.toon))
- Subcommand-token error contract: one unknown-subcommand code with nearest-match recovery across every subcommand family ([pm-185870](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-185870.toon))
- pm get cannot report linked files, tests, or docs in any projection, so the one command an agent uses to rebuild an item's context silently reports them as absent ([pm-tld20c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tld20c.toon))

### Security

- Refresh compatible 2026-08-08 development dependencies ([pm-8l1m5t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8l1m5t.toon))

## 2026.8.10 - 2026-08-10

### Added

- GH-472: create error for missing required custom fields lists the field names ([pm-4bzq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4bzq.toon))
- Provenance records distinguish unavailable configuration from resolver failures ([pm-lu6sca](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-lu6sca.toon))

### Fixed

- GH-959 recurrence: snapshot restore planning races lease-expiry fixture cleanup ([pm-usq49n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-usq49n.toon))
- GH-960: structured diagnostic notices preserve machine-readable JSON envelopes ([pm-embm6t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-embm6t.toon))
- GH-956: lossless acceptance-criteria replacement and unmatched-removal failure contract ([pm-lppm6y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lppm6y.toon))
- GH-954: fail-fast dependency target validation with explicit forward-reference intent ([pm-x3dq0l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x3dq0l.toon))
- Preserve executable recovery semantics across terminators, nested aliases, and tracker scope ([pm-szn67i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-szn67i.toon))
- Measure source replication against an independently discovered denominator ([pm-b84irw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b84irw.toon))
- GH-515: pm test --add reorders linked tests — --only-last can execute a non-newest command ([pm-x2vx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x2vx.toon))
- GH-490: unknown-command suggester ranks substring hits over synonyms/edit distance — pm log suggests 'extension catalog' ([pm-g543](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g543.toon))
- GH-441: type-aware create help mislabels applicable flags as required (ignores create-mode) ([pm-qmjx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qmjx.toon))
- GH-519: close recovery bundle suggests --validate-close "<value\>" for an enum flag and hides the real resolution-fields blocker ([pm-ulqu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ulqu.toon))
- GH-950: item-addressing commands reject a consistent --id alias and misroute recovery ([pm-mkinft](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mkinft.toon))
- GH-951: required-field policy can force fabricated relationship edges ([pm-st7wgu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-st7wgu.toon))
- GH-953: close recovery suggested_retry is not executable and drops supplied flags ([pm-p316vn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p316vn.toon))
- A sandboxed fixture records provenance from the host harness environment, so the suite is green on CI and deterministically red for any agent running it locally ([pm-xgah3a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xgah3a.toon))
- The session-role dimension is wired to a boolean child-session flag, so every nested claude-code invocation records the role literally as "1" and fleet analytics will group real work under a meaningless label ([pm-eq9dlw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eq9dlw.toon))
- GH-921/GH-922: merge-decision receipts are not durable in fresh-clone CI ([pm-1j5j21](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1j5j21.toon))
- GH-948: version-skewed pm invocations silently rewrite the tracked merge fence during unrelated commands ([pm-l56d0o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l56d0o.toon))
- A measurement ratchet bound stops enforcing the moment its owner reaches a terminal status, so every guarded population goes unbounded exactly when its fix ships ([pm-5z9plz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5z9plz.toon))
- The docs tree grows one file per shipped contract, so 39 of 51 documents are stubs and the SDK's story is split across twelve files ([pm-9hv1o7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9hv1o7.toon))
- The status-token normalization rule is replicated at five sites and the replication gate covers none of them ([pm-ulxdqp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ulxdqp.toon))
- The two slowest governance commands load every item body while twenty other SDK modules use the light read path ([pm-sr3xzg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sr3xzg.toon))
- GH-946: context signal-store staleness warning has no executable remediation contract ([pm-wn1jy1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wn1jy1.toon))
- GH-943: health remediation points at validate while actionable unknown-author recovery remains undiscoverable ([pm-jwmszf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jwmszf.toon))
- GH-942: expose the lightweight all-item metadata reader through the public SDK ([pm-yrj7qr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yrj7qr.toon))
- GH-941: pm read omits notes without declaring their omission and invites duplicate writes ([pm-swfelk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-swfelk.toon))

### Other

- Refresh pinned GitHub Actions for PR \#958 with exact-head compatibility proof ([pm-obh6lo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-obh6lo.toon))
- The measurement ratchet floors only aggregate graph totals, so converting typed semantic edges to untyped ones passes every declaration ([pm-70jyvw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-70jyvw.toon))

## 2026.8.9 - 2026-08-09

### Fixed

- The release gate cannot classify Sentry events emitted before its own contract producer shipped, so a correct usage refusal from an older release blocks the daily cut for the whole rolling window and clears only by hand ([pm-h75tjh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h75tjh.toon))
- Entity projections carry a collection key only when it is non-empty, so an absent key cannot be distinguished from an unprojected one and neither projection level is a superset of the other ([pm-b1w8vr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b1w8vr.toon))
- Ordering recorded as blocks is invisible to actionability: the same prerequisite schedules differently depending on which endpoint wrote it ([pm-jkbqt8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jkbqt8.toon))
- Dependency-kind lexicon: fifteen accepted spellings for roughly eight relations, canonicalized inconsistently at write time, so the stored graph vocabulary keeps fragmenting ([pm-4020c5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4020c5.toon))
- GH-930: duplicates --status all silently scans zero items ([pm-sy24w2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sy24w2.toon))
- GH-920: health conflates lossless merge receipts with discarded-value decisions ([pm-jtwsct](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jtwsct.toon))
- GH-937: package list exposes alias rows as packages and overstates the catalog total ([pm-fr6u17](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fr6u17.toon))
- Post-merge guidance names history-repair, which clears drift but never settles the merge receipt, so every merged item leaves a permanent merge_decisions_unreviewed warning ([pm-lwmstb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lwmstb.toon))
- GH-925: package manage diagnostics reject universal read-output controls ([pm-479ggz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-479ggz.toon))
- Surface replication gate activates unrelated sets through shared required members ([pm-kmnvug](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kmnvug.toon))
- GH-924: closed completed plans still recommend pm close ([pm-ltlcsw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ltlcsw.toon))
- Merge direction decides which agent's value survives: the same two branches converge to different item state depending on which side merges, and nothing reports the divergence ([pm-dlx7v7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dlx7v7.toon))
- GH-931: linked-test detector misclassifies unrelated node dist/cli.js commands as pm ([pm-u3o3ur](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u3o3ur.toon))
- Release candidate acceptance hard-codes the pre-bump CLI version and blocks the daily cut ([pm-7ipajv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7ipajv.toon))

## 2026.8.8 - 2026-08-08

### Added

- The CLI has 195 error codes and contracts none of them: the surface agents read when they are wrong is the only one with no enumeration, no stability promise, and no gate ([pm-x4nn3z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-x4nn3z.toon))

### Fixed

- PR \#935 review remediation: executable gate registry and fail-closed runtime context parsing ([pm-n41vay](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-n41vay.toon))
- GH-926: warn before a stale pm binary mutates a project pinned to a newer CLI/SDK ([pm-1eted6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1eted6.toon))
- PR \#935 CI: preserve dependency-free fast-version startup and regenerate runtime contracts ([pm-dskxwf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dskxwf.toon))
- Make stale-runtime compatibility classification action-aware across mixed CLI commands ([pm-zjelve](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zjelve.toon))
- CLI and SDK refusal contracts now preserve consistent codes and recovery semantics ([pm-0xmajx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0xmajx.toon))
- Sentry exception capture never writes the pm.error_code and pm.exit_code tags the release gate reads, so every unexpected runtime error is unclassifiable by construction and blocks the daily cut for the full rolling window ([pm-qxo5iu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qxo5iu.toon))
- Sentry PM-CLI-2S: resource-exhausted copy reports a high handled error without actionable storage guidance ([pm-4odf0c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4odf0c.toon))
- Sentry PM-CLI-2Q: expected snapshot-name validation is captured as a high production error ([pm-qyg51h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qyg51h.toon))
- The release gate classifies production errors by message prose and reads none of the 236 error codes the product declares, so every waiver is a latent re-block and a broad substring is a silent waiver ([pm-dqtzva](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dqtzva.toon))
- The mandatory command-wiring replication set is enforced only by a prose checklist, and the census shows partial application is the single largest recurring defect class in the record ([pm-7rrqsk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7rrqsk.toon))
- pm get silently discards --output-include field names because entity reads bind the flag to sections while collection reads bind it to fields, and the omission receipt reports no omissions either way ([pm-0k19l7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0k19l7.toon))
- GH-919: \_workspace author-attribution coordinates cannot be acknowledged ([pm-ety1qc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ety1qc.toon))
- pm comments write response replays the entire accumulated history, so one append can emit hundreds of comments ([pm-9stazf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9stazf.toon))
- GH-457: pm health hangs during vectorization check with no output (never-block violation) ([pm-tu71](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tu71.toon))

### Security

- GHSA-2v37-7h3g-55p8: pin patched nanoid in the Vite/PostCSS development graph ([pm-5dwz1a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5dwz1a.toon))
- GH-933: nested PM writes in non-PM linked tests can mutate the source project ([pm-alhqbz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-alhqbz.toon))

### Other

- One governed verification plan now drives local preflight and maps hosted release gates ([pm-ei6x66](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ei6x66.toon))
- Every command declares its exit-code set, and the code distinguishes applied from applied-to-nothing ([pm-hqa8g1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hqa8g1.toon))
- Floor polarity for the tracker measurement ratchet, with graph edge and node floors declared ([pm-z0cfor](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z0cfor.toon))
- Refresh tsx to 4.23.11 with full release-gate proof ([pm-nw1y14](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-nw1y14.toon))

## 2026.8.7 - 2026-08-07

### Added

- Caller-carried output sessions compose token budgets across reads and suppress repeated item facts ([pm-hid9g1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hid9g1.toon))
- Fleet attribution analytics: per-harness and per-model throughput, rework, and defect-escape rates derived from immutable history alone ([pm-gw6uyq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gw6uyq.toon))
- Improvement ledger: measured properties of pm carry a recorded time series, because a ceiling proves a number did not grow and can never prove a change made it smaller ([pm-chahyq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-chahyq.toon))

### Changed

- Update @toon-format/toon to 4.1.1 and verify codec compatibility ([pm-ko35zx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ko35zx.toon))

### Fixed

- Nested pm test coverage changes repository-root fixtures because outer PM_PATH sandboxing leaks into package-owned run-tests ([pm-ay3l0p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ay3l0p.toon))
- Read surfaces have no common row contract: field projection reaches 4 of 11 commands and the row collection sits under a different key on each, so no single shell or jq expression works across pm ([pm-sb0tns](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sb0tns.toon))
- Sentry PM-CLI-2W: rejected unknown-author acknowledgments are emitted as high production errors ([pm-c3uru0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c3uru0.toon))
- Expose live bounded provenance coverage over immutable history ([pm-1wiugq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1wiugq.toon))
- GH-915: Windows nightly Vite import portability and shared contract-fixture isolation regressions ([pm-ssd7vv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ssd7vv.toon))
- GH-914: macOS extension source identity compares non-canonical /var and /private/var paths ([pm-eu46an](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eu46an.toon))
- The coverage gate every contributor is told to run is not a gate: run-tests.mjs coverage prints the shortfall and exits 0, so only CI can fail on coverage ([pm-2qqcgl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2qqcgl.toon))
- The one projection that promises completeness is the one that loses data: pm contracts --full drops all 76 structured command summaries, returns 160 bare name strings, and reports has_omissions false ([pm-x0iv17](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x0iv17.toon))
- GH-910: keep extension assets outside item merge-driver patterns ([pm-t9qbmp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-t9qbmp.toon))
- GH-911: preserve runtime dependency resolution in post-install activation probes ([pm-pg9599](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pg9599.toon))
- GH-912 regression: restore atomic cross-owner seeded Plan creation ([pm-hxuqsa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hxuqsa.toon))

### Other

- Refresh compatible tooling dependencies: tsx 4.23.8 and pm-changelog 2026.8.6 ([pm-l9fv1e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-l9fv1e.toon))

## 2026.8.6 - 2026-08-06

### Fixed

- GH-909: executable extension migration application and remediation contract ([pm-ig5cfe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ig5cfe.toon))
- GH-908: explicit package-source identity and bare-name ambiguity diagnostics ([pm-495lkc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-495lkc.toon))
- GH-907: preflight override ownership and statically disjoint command scopes ([pm-miy5k6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-miy5k6.toon))
- Release ratchet verdicts are a property of the working copy, not the commit: gitignored installs and clone-local git config decide three populations, so an identical commit passes locally and fails in CI ([pm-fr4dg8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fr4dg8.toon))
- Exact-tag Release recovery must bootstrap tracker gates and publish an unpublished immutable tag from its tagged source ([pm-lwnifd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lwnifd.toon))

### Other

- Refresh compatible 2026-08-05 TypeScript-ESLint and Unicorn quality tooling ([pm-7gxbl8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7gxbl8.toon))

## 2026.8.5 - 2026-08-05

### Fixed

- GH-896: heterogeneous atomic specification batches need batch-local references and one discoverable SDK-first CLI path ([pm-o8z748](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-o8z748.toon))
- Completion is decomposed while creation is composed: create takes nine inline evidence flags, close takes none, so the prescribed finish protocol is seven invocations and seven unrelated history entries ([pm-cyn0y6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cyn0y6.toon))
- Reindex coverage test leaks semantic refresh HTTP beyond its mock lifetime ([pm-cflhoj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cflhoj.toon))
- Sentry PM-CLI-2V: pm init surfaces raw EACCES when the managed workspace .gitignore cannot be written ([pm-3gh457](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3gh457.toon))
- Filed defect populations grow after they are measured and nothing turns a tracker measurement into a ceiling: the maintenance passes that record the count are the writer that widens it ([pm-ips23h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ips23h.toon))
- Tracker-only PM governance commits cannot satisfy required CI without changing the generated changelog ([pm-2x5x83](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2x5x83.toon))
- GH-891: external blockers make graph stale_lifecycle_block impossible to resolve truthfully ([pm-6sc8jq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6sc8jq.toon))
- GH-889: merge-conflict recovery guidance hides the durable discarded-value report ([pm-fbrz7p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fbrz7p.toon))
- GH-890: extension collision diagnostics omit the effective winner and cannot distinguish safe scoped overlap ([pm-6mjxgq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6mjxgq.toon))
- GH-885: create-time close_reason_required recovery recommends an impossible different-command retry ([pm-5uclvd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5uclvd.toon))
- GH-887: terminal create contract is non-atomic and inconsistent across importer-facing closure metadata ([pm-ykdt4m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ykdt4m.toon))

### Security

- 2026-08-04 holistic pm CLI, SDK, and ecosystem manual review and optimization plan ([pm-gzyt2j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-gzyt2j.toon))

### Other

- Auto Release fresh clones build the CLI and install merge drivers before tracker gates ([pm-xvccnm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xvccnm.toon))
- Tracker data-quality ratchet in CI: pm validate and pm health run against this repository's own workspace with a shrinking-only per-warning baseline ([pm-kpftft](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kpftft.toon))
- Eliminate July static-analysis nullability, dead-code, and redundant-allocation findings ([pm-cp5pbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cp5pbo.toon))

## 2026.8.4 - 2026-08-04

### Added

- GH-471: pm context includes an installed package/extension health summary ([pm-h85e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-h85e.toon))
- Static contribution manifest: persist the install-time contribution inventory so the command registry is built from data and extension modules import only when a contribution is actually invoked ([pm-021kdp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-021kdp.toon))

### Fixed

- Uniform multi-value filter-value grammar: --status accepts CSV but --type/--priority fail fast and --tag silently matches the literal CSV string ([pm-gknu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gknu.toon))
- list applies an undisclosed default lifecycle scope and reports the scoped count as the corpus total with has_more false, while search applies no such scope, so the two discovery surfaces disagree about what exists ([pm-999jh7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-999jh7.toon))
- GH-882: unresolved extension commands must lead with the activation failure and actionable recovery ([pm-4uplae](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4uplae.toon))
- Extension-mode is folded into the metadata-cache identity, so alternating --no-extensions with a normal invocation evicts a 4.5 MB cache and every command costs 5 seconds instead of 0.4 ([pm-77okxr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-77okxr.toon))
- Declared activation.commands is silently overridden by the renderers/hooks/parser/preflight capability tier, so any extension beyond plain commands is eagerly imported on every invocation ([pm-j0w7j9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j0w7j9.toon))
- GH-832: package command namespace ownership and collision diagnostics are not discoverable ([pm-6z0wzf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6z0wzf.toon))
- GH-681: latest calendar ordinal must satisfy stable package peer ranges ([pm-csuce0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-csuce0.toon))
- The model provenance resolver derives the harness session-file path with an incomplete slug encoding, so it silently resolves nothing in any workspace whose path contains an underscore - including this repository ([pm-9gvazz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9gvazz.toon))
- GH-878: nested workspace snapshot and help paths are enumerated but not resolvable by structured help ([pm-7wx1f9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7wx1f9.toon))
- Warn when custom schema fields collide with MCP transport or tool-specific inputs ([pm-yfdav2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yfdav2.toon))
- GH-844: local npm package archives are rejected as install sources ([pm-lw6acw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lw6acw.toon))
- The one-release-per-day guard compares a prefix glob against unpadded date keys, so it is correct only by accident of tag creation order and silently skips a real release for any out-of-order tag ([pm-ki67py](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ki67py.toon))

### Security

- Refresh transitive brace-expansion and PostCSS patches for 2026-08-03 audit advisories ([pm-2cv2o1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2cv2o1.toon))

### Other

- Scripting contract: documented and test-gated guarantees for exit codes, stdout/stderr stream discipline, and stable machine-readable field names ([pm-psy1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-psy1.toon))
- Published artifact weight: the npm tarball ships 20MB of inline-source sourcemaps plus duplicate tsc and bundle outputs ([pm-998juj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-998juj.toon))

## 2026.8.3 - 2026-08-03

### Added

- One declared output-bounding dimension set on every read surface: 25 flag spellings across 19 commands collapse to include / how-much / cost / encoding, with a precedence algebra and permanent aliases ([pm-hb7ug8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hb7ug8.toon))
- Intent-scoped read projections: a command returns exactly the fields the declared intent consumes, so agents stop paying for fields they discard ([pm-cxr0jb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cxr0jb.toon))

### Fixed

- Auto Release coverage depends on a /proc timing race in the SDK entrypoint sampler ([pm-q2a7hr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-q2a7hr.toon))
- The author field is an ungoverned free-text vocabulary: 477 distinct spellings across 41,021 immutable entries encode harness, model, session role, topic, and date because those dimensions had no fields, and the record cannot be rewritten ([pm-3yxwv5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3yxwv5.toon))
- Recorded agent provenance is unreadable in practice: the only projection carrying it also carries every JSON Patch operation at 63.5x the compact cost, and no read surface can filter on harness, model, effort, or instance ([pm-v8gfi7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v8gfi7.toon))
- Harness provenance can only be declared as environment variables, so the model the primary harness publishes in its own session record is inexpressible: 900 of 900 explicit entries still record model null while effort resolves ([pm-ffz0a9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ffz0a9.toon))
- GH-867: linked files and docs no-op additions report changed and append phantom history ([pm-jb1ron](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jb1ron.toon))
- GH-868: atomic replacement contract for linked files and docs ([pm-cstuys](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cstuys.toon))
- GH-865: classify linked-test lock contention as infrastructure collision ([pm-2irc1p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2irc1p.toon))
- GH-779 recurrence: history-redact must refresh item and drift projections atomically ([pm-wnbk2l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wnbk2l.toon))
- GH-870: make runtime workspace path assertions portable in Windows nightly ([pm-rusbe4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rusbe4.toon))
- GH-871: preserve letter-suffixed issue codes in duplicate similarity scoring ([pm-sn3xor](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sn3xor.toon))
- GH-866: telemetry flush queue-drain contract reports partial progress as fully drained ([pm-u5c27w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u5c27w.toon))

### Security

- GH-864: history-redact output must never echo literal secrets ([pm-y3w0ld](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-y3w0ld.toon))

## 2026.8.2 - 2026-08-02

### Added

- Episode identity: a stable, labelled, nestable episode key that survives process, surface and harness boundaries so trajectory grouping and fleet aggregation have a join key ([pm-oqo9l2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oqo9l2.toon))

### Fixed

- Both published bin names are refused as subcommands, so npx PKG pm init and bunx PKG pm init fail while the version probe that guards them passes ([pm-rnl3sa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rnl3sa.toon))
- The intent budget binds downward and is inert upward: a sevenfold budget increase buys zero rows and the field that would reveal the clamp is omitted exactly when it applies ([pm-prsvjh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-prsvjh.toon))
- The MCP action vocabulary is not derived from the CLI contract table: 26 MCP-only spellings, and seven contracted capability families including merge, workspace snapshot and eval have no MCP route at all ([pm-0834kq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0834kq.toon))
- The SDK boundary gate proves the CLI stopped importing private core and never proves the CLI only imports the published SDK, so ten private SDK modules carry our own commands ([pm-xpumg4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xpumg4.toon))
- GH-855: core mutation locators must honor extension-registered item types ([pm-scga6k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-scga6k.toon))
- GH-853: extension command test harness must inject the real host-bound SDK ([pm-wx2lr5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wx2lr5.toon))
- Session-topic provenance has no descriptor keys on any harness, and effort/role are wired for only claude-code and codex, so most fleet history records harness and model but nothing about the work's shape ([pm-rbg1qo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rbg1qo.toon))
- Explicit-unavailable provenance is recorded for the model dimension only, so effort and role absence is permanently indistinguishable from a legacy entry ([pm-9wbiye](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9wbiye.toon))
- GH-851: compare init discovery roots by filesystem identity ([pm-noq46i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-noq46i.toon))
- GH-847: tighten managed built-in static SDK contracts and author guidance ([pm-ka6m65](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ka6m65.toon))
- The MCP server never receives the harness provenance environment, so one agent session writes permanently divergent identity records depending on which surface it used ([pm-1zhfls](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1zhfls.toon))
- The bounded read costs 13.8 times the unbounded read to deliver the same set, because eight metadata blocks are re-emitted per page and the page carries two rows ([pm-sf31yl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sf31yl.toon))
- Declared intent token budgets are smaller than the smallest projection their own command can emit, so three of five intents return no result at all on this tracker ([pm-yekkvt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yekkvt.toon))
- Declared read-intent token budgets are written to a flag three of five intent commands do not accept, so the shipped intent layer overruns its own declaration by up to 43.8x ([pm-7hbfch](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7hbfch.toon))
- The public SDK's item-lifecycle surface re-exports CLI command modules, so lifecycle policy cannot be expressed, inspected, or overridden through the SDK ([pm-z5pmf8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-z5pmf8.toon))

### Security

- GH-854: transactional extension mutation guards for enforceable domain invariants ([pm-hx23u5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hx23u5.toon))
- CodeQL alert 33: eliminate polynomial trailing-whitespace matching in SDK append ([pm-8wskoj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8wskoj.toon))

### Other

- Self-reported token accounting: any command can report the token cost of its own output so budget spend is attributable at runtime and in CI ([pm-t5dt4z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t5dt4z.toon))

## 2026.8.1 - 2026-08-01

### Fixed

- Mutation echo parity reversed after pm-nilh closed: the MCP surface now returns 5.2x the CLI default for an identical create ([pm-awe3t6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-awe3t6.toon))
- The bunx release gate passes with an arbitrary token in the executable position, so the only Bun coverage in the pipeline cannot fail for the reason it exists ([pm-lpqln4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lpqln4.toon))
- The published-artifact gate never executes pm-mcp: two of three declared bins resolve to the same file and the third — which already shipped dead once — has zero release coverage ([pm-u0oz2k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u0oz2k.toon))
- One governance rule, two terminal-transition paths, opposite answers: pm close refuses a reasonless close while pm update --status closed invents a reason and writes it into the immutable record unmarked ([pm-2ew0w3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2ew0w3.toon))
- Closing an item deletes its ordering edges, so the historical ordering graph is structurally unable to exist ([pm-xm0id4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xm0id4.toon))
- GH-831: actionable unknown-author health evidence is truncated without a complete disposition selector ([pm-1bmeta](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1bmeta.toon))
- GH-841: init ancestor discovery obscures the selected workspace and safe current-directory target ([pm-ipbwcq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ipbwcq.toon))
- GH-840: annotation primitives lack a merge-safe structured event append and query contract ([pm-09rdni](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-09rdni.toon))
- GH-839: extension field declarations accept types the persisted schema cannot validate ([pm-tom5xp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tom5xp.toon))
- Harness-detection specs inherit the ambient harness, so four tests fail under Claude Code and pass in CI on the same commit: the local verdict depends on which agent ran it ([pm-631t9p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-631t9p.toon))
- Extension-registered item types are created, stored and versioned like any other item but are invisible to the merge fence and its drift detector, which reports the fence clean ([pm-5rexki](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5rexki.toon))
- Four edge-counting conventions publish under one edge_count field: graph analyze reports 10046 and graph centrality 7351 for the same graph at the same cache fingerprint ([pm-jiusod](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jiusod.toon))
- Four read surfaces publish a jq_selector that is guaranteed to return nothing: the self-describing row contract is present, vacuous, and indistinguishable from an empty result ([pm-x710qm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x710qm.toon))

### Security

- GH-827: local package install must prevent recursive self-copy and disk exhaustion ([pm-0682l4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0682l4.toon))

### Other

- Refresh compatible Sentry 10.69 and Greptile 3.3 dependencies ([pm-7564ov](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7564ov.toon))

## 2026.7.31 - 2026-07-31

### Fixed

- Exact-tag npm recovery must stabilize public package access before verification ([pm-t310hx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-t310hx.toon))
- GH-830: duplicate-safe creation must require explicit bypass before persistence ([pm-35w9l2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-35w9l2.toon))
- GH-828: init status registries must expose one coherent alias contract ([pm-62n4kk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-62n4kk.toon))
- GH-826: extension commands need structured failure results and preserved remediation ([pm-ye9v2t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ye9v2t.toon))
- GH-825: restore SDK excess-property safety for extension definition metadata ([pm-unwsns](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-unwsns.toon))
- GH-824: core-field recovery must name dedicated flags instead of extension activation ([pm-2jtbl8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2jtbl8.toon))
- CodeFactor fixed-only success payload blocks exact-head release gate ([pm-xcrlkl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xcrlkl.toon))
- Both declared context intents are unreachable because the intent applier assigns field-group names into the section value domain, and the two validators give contradictory advice ([pm-ai45y9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ai45y9.toon))
- GH-814: SDK metadata reads must distinguish missing and invalid tracker roots from an empty tracker ([pm-23xkss](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-23xkss.toon))
- The runtime contract enumeration is not closed over the surface it can resolve: 14 rendered commands, including the list-open that AGENTS.md mandates, are contract-backed by name yet absent from every enumeration ([pm-6j7r1a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6j7r1a.toon))
- GH-817: machine-readable flag contracts need semantic invocation metadata and stdin capability ([pm-11phn1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-11phn1.toon))

## 2026.7.30 - 2026-07-30

### Added

- Omission receipts: every bounded read shape names the field groups it withheld and the flag that restores each, with the same rigor row truncation already has ([pm-p258tx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-p258tx.toon))

### Fixed

- Workspace snapshot heartbeat races atomic root activation and loses its writer lock ([pm-ifuysd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ifuysd.toon))
- GH-815: optional missing merge drivers must be advisory in default health verdicts ([pm-r8u2g6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r8u2g6.toon))
- Sentry gate misclassifies handled snapshot identifier validation as a blocking runtime error ([pm-k785lu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-k785lu.toon))
- Scale fixtures vary only in size: the sole synthetic workspace generator hardcodes population shape, so the million-item tier is eleven simulated days deep with one history entry per item ([pm-vv2lti](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vv2lti.toon))
- Whole-workspace snapshot restore silently rewinds the immutable record: history streams are deleted and nothing records that a rewind happened ([pm-6l2mza](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6l2mza.toon))
- GH-808: lifecycle completion resolver types and provenance lie when no timestamp exists ([pm-qhnq6t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qhnq6t.toon))
- pm activity --compact --json emits an empty activity:\[\] decoy key alongside compact_activity ([pm-p3x4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p3x4.toon))
- Mode-paired envelopes zero-fill the inactive collection instead of omitting it, so parsing the obvious key returns an empty array that is indistinguishable from a real empty result ([pm-cyrfjq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cyrfjq.toon))
- GH-802: persist structured numeric measurements with test runs ([pm-ygerpy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ygerpy.toon))
- GH-806: publish and reuse the eval query-set contract across help, errors, SDK, and machine discovery ([pm-wd61s2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wd61s2.toon))
- The rendered command surface is not a subset of the contracted surface: pm workspace ships in help, runs, and exits 2 on its own contract lookup, and no gate compares the two sets ([pm-1jrdri](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1jrdri.toon))
- GH-797: rank read/show/view recovery by executable intent and bounded contracts guidance ([pm-bex0ui](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bex0ui.toon))
- GH-803: hoist repeated linked-test execution context and honor lean output ([pm-fqdmbf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fqdmbf.toon))
- GH-807: make the default eval query set version-controllable in every initialized workspace ([pm-jdh1jg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jdh1jg.toon))

### Other

- The product advertises CI gates in its own help that no pipeline runs: pm eval names --fail-under a CI gate and nothing consumes it ([pm-b2hc4x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b2hc4x.toon))
- Gate registry: every enforced CI and release gate has an owner item, a declared failure taxonomy, a bypass policy, and a negative-control fixture proving it fails on known-bad input ([pm-k6t4yb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k6t4yb.toon))

## 2026.7.29 - 2026-07-29

### Added

- GH-787: workspace snapshot and restore primitives for cheap reproducible evaluation episodes ([pm-dkrmzv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dkrmzv.toon))
- Reproducible workspace instances: seeded identifiers, injectable clock, and byte-identical construction from a declared recipe ([pm-rbcvt2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rbcvt2.toon))

### Fixed

- GH-676: list tag filter must accept the CSV shape used by tag mutations ([pm-b1zsk9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b1zsk9.toon))
- GH-675: lifecycle must record actual completion time separately from tracker close time ([pm-bwnclq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bwnclq.toon))
- GH-711: update must support intentional unresolved parent references under strict governance ([pm-cragzs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cragzs.toon))
- GH-715: expose mutation-guard policies through canonical config help and output ([pm-5ecnar](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5ecnar.toon))
- GH-672: pm context low_level rows omit blocked state and blocker IDs ([pm-r2suqb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r2suqb.toon))
- GH-651: pm activity bare relative windows silently return empty results ([pm-b0twiy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b0twiy.toon))
- GH-784: SDK blueprint preflight misses host-owned flag collisions and malformed long-flag tokens ([pm-huolbk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-huolbk.toon))
- GH-785: align pm health ok with warn-only exit semantics on fresh clones ([pm-83ov2i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-83ov2i.toon))
- GH-792: fresh-clone health must not require ignored runtime and empty extension directories ([pm-0k4o8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0k4o8t.toon))
- GH-793: remove or disambiguate list --all so filtered output cannot claim workspace completeness ([pm-q7qojt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-q7qojt.toon))
- GH-794: make copied identity output_format overrides decline instead of exposing the host envelope ([pm-wi301j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wi301j.toon))
- Nightly static quality fails closed in shallow workflow checkouts because CodeFactor parity cannot resolve a committed base ([pm-1hbw4y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1hbw4y.toon))
- GH-790/GH-791: pm merge install reports workspace_root in a different canonical form depending on which channel resolved it, so the same repository has two non-equal spellings on macOS and Windows ([pm-ihmfs6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ihmfs6.toon))
- The dependency token budget is enforced against a different representation than the one emitted, so a command that reports staying inside 16k tokens delivers about 45k ([pm-t2t709](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-t2t709.toon))
- pm activity has no default bound: a bare invocation returns all 40,446 history entries at 1.59M tokens, 397x the ceiling its own contract declares ([pm-z2j1qt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-z2j1qt.toon))
- Both token gates are structurally unable to fail: one measures only help payloads, the other measures command output against a three-item fixture, so no check anywhere compares real output to the ceiling the contract declares ([pm-9sui7t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9sui7t.toon))
- Sentry PM-CLI-2N: malformed missing tags crash normalizeItemMetadata before search can report the item ([pm-89neyq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-89neyq.toon))
- pm-governance-audit comments-audit limit contract contradicts runtime alias semantics ([pm-v657](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v657.toon))
- pm-governance-audit dedupe-audit rejects --status all, breaking explicit all-lifecycle duplicate sweeps ([pm-mp49](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mp49.toon))
- GH-781: managed built-in extensions redeclare public SDK contracts locally, and the mirrors already disagree with the authoritative declarations in shipped packages ([pm-vnk7ob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vnk7ob.toon))

### Security

- GH-799: confine custom item-type storage folders to the tracker root ([pm-d30cmk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d30cmk.toon))
- PR \#795 exact-head review hardening: dependency budget progress, rendered fixed points, nightly credential isolation, and drift-cache diagnostics ([pm-jd3m6p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jd3m6p.toon))

### Other

- Refresh compatible 2026-07-29 development dependencies ([pm-77bmeu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-77bmeu.toon))
- Token-budget gate corpus is unrepresentative in both scale and coverage: budgets are set on a seeded micro-workspace and the largest agent-facing payloads are not measured at all ([pm-z71aoy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z71aoy.toon))
- GH-782: guide-shell special-cases one multi-word command name and duplicates its status derivation, and calendar's throw-only validation call is unexplained, inside package-managed built-ins consumers cannot patch ([pm-cb8qq2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cb8qq2.toon))

## 2026.7.28 - 2026-07-28

### Added

- MCP tool profiles: core/standard/full/custom tiers with an allowlist override, so 31 tools are the maximum surface, not the default ([pm-9k90](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9k90.toon))
- MCP resources and prompts surface: expose workspace context as addressable resources and canonical workflows as prompts, not only as tools ([pm-yf07b7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yf07b7.toon))
- Project live workspace schema and extension commands into MCP discovery and mutations ([pm-m4ikkz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m4ikkz.toon))
- Public SDK contracts and static runtimes let extension authors reuse the CLI baseline ([pm-w7mqzt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-w7mqzt.toon))

### Changed

- Dedupe flag-contracts.ts repetitive per-command blocks (9 internal clones, ~150 lines) ([pm-ueuq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ueuq.toon))

### Fixed

- GH-770: pending merge receipts remain invisible to validation and CI before reconciliation ([pm-ysqb6n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ysqb6n.toon))
- GH-775: make fresh-clone health distinguish material tracker loss from absent empty type folders ([pm-xyuhh7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xyuhh7.toon))
- GH-779: invalidate history drift cache after item and repair mutations ([pm-ajaskl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ajaskl.toon))
- The merge fence covers item documents but not tracked non-item JSON, so .managed-extensions.json line-conflicts between agents on different branches ([pm-gjicmx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gjicmx.toon))
- GH-773: install portable merge drivers without permanent checkout-path drift ([pm-w91mvg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-w91mvg.toon))
- GH-776: preserve output override compatibility and export the public decision contract ([pm-u2tqn6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u2tqn6.toon))
- GH-778: make lean structured reads omit caller echoes and inactive pagination metadata ([pm-oi4zs3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oi4zs3.toon))
- GH-772: rejected extension command registration leaves silent partial activation and zero-exit command gaps ([pm-4vwcvq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4vwcvq.toon))
- The surface-discovery contract costs 31k tokens in its brief form and still omits every flag, so the cheapest way to learn pm is the most expensive call it offers ([pm-gmdzaa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gmdzaa.toon))
- Linked-test schema sandbox breaks package prepare hooks that install the PM merge driver ([pm-uawujr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-uawujr.toon))
- The list family exposes three incompatible --json projections under one flag, so an agent filtering on an unprojected field silently reads absent instead of unset ([pm-pjnu91](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pjnu91.toon))
- GH-768: deduplicate public SDK provenance exports across core and root entrypoints ([pm-44aa4x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-44aa4x.toon))
- GH-766: Windows nightly extension timeout and merge-safety cleanup EBUSY ([pm-25b7tg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-25b7tg.toon))
- Merge-fence scope ambiguity: extension-contributed item folders make default validation disagree with the no-extensions CI baseline ([pm-mkzw1x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mkzw1x.toon))
- GH-764: one host-global flag collision quarantines an entire extension and suggests reinstalling the installed package ([pm-gnowgi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gnowgi.toon))
- Recovery bundle mines flag names from usage-error prose: scope errors like '--rebuild and --clear apply only to graph index' yield missing:--clear + suggested_retry appending the other invalid flag ([pm-ikv6m0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ikv6m0.toon))
- GH-755: dependency edges are written with a null author, so the relationship graph is the only recorded collection with no provenance ([pm-0a24f5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0a24f5.toon))
- GH-752: list results claim completeness while unreadable items are omitted ([pm-57ir3b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-57ir3b.toon))
- GH-763: merge-decision receipt persists shell-quoted item_path that cannot resolve ([pm-9nfpwd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9nfpwd.toon))
- GH-747: the bundled TOON encoder emits documents its own decoder rejects, so a valid item becomes permanently unreadable ([pm-avv3wx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-avv3wx.toon))
- Identity provenance is a fixed three-dimension schema, so the reasoning level sitting in the environment right now and any session role are structurally unrepresentable ([pm-itsjf0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-itsjf0.toon))
- Model capture is inert in practice: zero of 35,103 recorded entries carry a model, because the declared signal for the primary harness is an environment variable that harness does not set ([pm-0zcwz6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0zcwz6.toon))
- The public harness detectors default env to an empty object, so detectAgentIdentity() and detectHarnessIdentity() silently return empty for every SDK caller ([pm-pwq0g5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pwq0g5.toon))
- GH-746: the release publish step guards on a package scope that does not exist, so publish idempotence and access recovery are permanently dead code ([pm-2z9263](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2z9263.toon))

### Other

- Evaluate Sentry 10.68.0 compatibility and retain 10.67.0 ([pm-r31390](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r31390.toon))
- Derive ALL MCP tool inputSchemas from \*\_FLAG_CONTRACTS — eliminate hand-declared parallel schema tables (extend the pm_copy pattern) ([pm-xwah](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xwah.toon))
- Generate shell completions, MCP tool registrations, and command reference docs from the contracts table (single source of truth) ([pm-mu8m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mu8m.toon))
- The agent token-surface harness from pm-a22j is wired into nothing, so output-size regressions like the 33k-token health check land undetected ([pm-dpqa3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dpqa3h.toon))
- Ecosystem review and deep-graph enrichment pass 2026-07-27: all-status census, CLI simplification + token-efficiency + long-term brainstorm, dedupe-checked gap filing ([pm-89qv6b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-89qv6b.toon))
- Evaluate @toon-format/toon 4 compatibility and item-format migration ([pm-5cgm2z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5cgm2z.toon))
- ADR amendment: extensible durable agent provenance dimensions and privacy boundaries ([pm-oskdmu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-oskdmu.toon))
- SDK completeness is asserted by a 10-case curated array against 85 declared actions: the boundary proves the CLI reaches nothing below the SDK, nothing proves the SDK can do what the CLI does ([pm-te6elw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-te6elw.toon))

## 2026.7.27 - 2026-07-27

### Fixed

- GH-754: the merge driver's field-level conflict report is transient stdout, so the value it discarded leaves no durable record anywhere ([pm-rh98vo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rh98vo.toon))
- Merge fence fails open: an unresolvable pm driver leaves unmarked UU files whose naive resolution silently discards the other branch's fields and history ([pm-c0wthb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c0wthb.toon))
- Merged-main Windows init package acceptance exceeds generic Vitest timeout ([pm-0vkmqs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0vkmqs.toon))
- GH-739: expose duplicate-cluster discovery as a first-class CLI and SDK workflow ([pm-n13lzc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-n13lzc.toon))
- PmClient activation queue serializes unrelated workspaces and extension-free actions ([pm-zpoyg9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zpoyg9.toon))
- GH-741: replace reference-identity service override claiming with an explicit observable contract ([pm-h3ipax](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h3ipax.toon))
- GH-740: make the documented aggregate SDK barrel complete and continuously derived ([pm-obbh43](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-obbh43.toon))
- GH-738: publish the machine-readable public SDK surface snapshot with the package ([pm-lnswp0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lnswp0.toon))
- Terminal release transitions retain stale claim_principal ownership ([pm-bnrndo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bnrndo.toon))
- SDK: inject host-bound runtime into ImportExportContext ([pm-i7indd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i7indd.toon))
- Detected agent identity is not agent-unique, so claim mutual exclusion silently degenerates across a same-harness fleet ([pm-z8qd4k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-z8qd4k.toon))
- GH-714: linked-test verbose child stdout still aborts with EAGAIN after bounded-drain fix ([pm-5sm91o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5sm91o.toon))
- CodeFactor 2026-07-26 SDK and digital-twin regression cluster (GH-722 through GH-732) ([pm-eq3ak8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eq3ak8.toon))
- GH-733: Windows Node 24 nightly portability regressions in author, recovery, and drift tests ([pm-wr8utz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wr8utz.toon))
- Sentry PM-CLI-2M: classify workspace audit-state drift as an actionable conflict ([pm-o71t68](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-o71t68.toon))
- GH-728: preserve live harness authorship across initialized multi-agent workspaces ([pm-si2uur](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-si2uur.toon))
- GH-720: diagnose unbuilt GitHub extension sources and recommend resolvable npm artifacts ([pm-0sx3kz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0sx3kz.toon))
- GH-719: reject or diagnose extension command flags shadowed by pm globals ([pm-ill9gv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ill9gv.toon))

### Security

- Scorecard Security-Policy (4→10): enrich SECURITY.md to full scoring depth ([pm-2d7k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2d7k.toon))
- Scorecard Fuzzing (0→10): add a fuzzing/property-based harness for the parser and codec surfaces ([pm-0yi7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0yi7.toon))

### Other

- The merge-safety gate verifies one history stream of 2,058 and never checks drift, so a clean merge that provably corrupts stream anchoring passes CI green ([pm-pdr8t1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pdr8t1.toon))
- Branch merge is an unrecorded mutation: the field-aware merge produces an item state that no history entry ever produced, so the merged state is unaddressable by restore and point-in-time reads ([pm-9j2r3b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9j2r3b.toon))
- Continuous multi-branch merge conformance: randomized N-branch divergence and merge property suite with a zero-conflict acceptance bar ([pm-76dnfg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-76dnfg.toon))
- 2026-07-26 ecosystem review: all-status walk, graph depth enrichment, agent-ergonomics and release-pipeline verification ([pm-v4iypw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-v4iypw.toon))
- Historical release attribution backfill: stamp every terminal item with the release tag that contains its close event ([pm-3j6it6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3j6it6.toon))
- Terminal relationship backfill, evidence-derived tranche: make every closed and canceled item reachable by typed graph traversal ([pm-qudvto](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qudvto.toon))
- 2026-07-26 agent-context readiness audit: full CLI, SDK, and ecosystem review and optimization plan ([pm-t9e3bc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-t9e3bc.toon))
- Ecosystem review and deep-graph enrichment pass 2026-07-26: all-status inspection, CLI simplification + context-algorithm brainstorm, gap filing ([pm-e9yevx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e9yevx.toon))

## 2026.7.26 - 2026-07-26

### Added

- Immutable-tree DeepScan and CodeFactor zero-new-issues release gate ([pm-39cqqx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-39cqqx.toon))
- Model-aware agent identity: detection resolves harness, model, and session so an agent never types an identity flag and history still records which model acted ([pm-03pq3o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-03pq3o.toon))

### Changed

- Dependabot update queue 2026-07-21: PRs \#618-\#621 ([pm-pegcmx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-pegcmx.toon))
- Harness signal registry: identity detection becomes declared data that a config entry or a package can extend without a code change ([pm-brxdct](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-brxdct.toon))
- Public SDK surface snapshot and breaking-change gate: the exported API is a reviewed artifact, and an unintended removal or signature change cannot merge ([pm-e6tm5c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e6tm5c.toon))

### Fixed

- GH-716: detect npm and Slack credential shapes in mutation secret guard ([pm-fhhhlk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fhhhlk.toon))
- pm package init doubles the pm- prefix and mints an unusable pm pm ... command path when given the package name every real pm package actually uses ([pm-c5f0gh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c5f0gh.toon))
- pm extension --init and pm package init are divergent scaffold generators behind the same grammar; the extension path emits no tests and an unpublishable manifest ([pm-9smp7j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9smp7j.toon))
- Built-in help examples teach an explicit --author on dozens of commands, training every agent to suppress its own detected identity and pay tokens for it ([pm-sx52hr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sx52hr.toon))
- Shipped MCP manifests and MCP tool guidance hardwire a static author, overriding the automatic identity of every plugin-hosted agent ([pm-zqsrt5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zqsrt5.toon))
- A configured author_default suppresses harness detection entirely, so any workspace that sets a default author records no harness and no model provenance ([pm-6uxhe0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6uxhe0.toon))
- GH-677: pm-path relocation must diagnose extension discovery changes ([pm-qswf81](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qswf81.toon))
- GH-691: parseItemDocument errors need stable structured SDK classification ([pm-r9pudt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r9pudt.toon))
- First-party service collision: builtin-calendar and builtin-guide-shell both override the global output_format service ([pm-ixoa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ixoa.toon))
- GH-680: completed Plan close must transition plan_mode terminally ([pm-g512pv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g512pv.toon))
- GH-692: plan update-step must persist file, test, and doc evidence fields ([pm-z5vamp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-z5vamp.toon))
- GH-678: linked-test sandbox must preserve freshly installed project extensions across child processes ([pm-jvken3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jvken3.toon))
- GH-709: batch duplicate-cluster sweep with canonical precomputed similarity signals ([pm-2i12ti](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2i12ti.toon))
- pm config set on one leaf key rewrites settings.json with every default materialized and silently replaces explicit stored values (validation.parent_reference warn -\> strict_error) ([pm-x2aplf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x2aplf.toon))
- GH-690: plan resume and approve must apply or reject scope changes ([pm-bxdlfa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bxdlfa.toon))
- GH-688: seeded Plan creation must be atomic across ownership boundaries ([pm-96tter](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-96tter.toon))
- GH-679: linked-test output capture must not abort verbose child tools with EAGAIN ([pm-j36ypd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j36ypd.toon))
- Author-resolution bypass class: create/copy and the context, next, and usage-feedback paths re-implement author precedence without harness detection, stamping author 'unknown' on new items ([pm-42p9nk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-42p9nk.toon))
- GH-706: accept bare conventional forms for create/update boolean metadata flags ([pm-ulb3rc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ulb3rc.toon))
- GH-700/GH-701/GH-702: nightly Node 22 and cross-platform regression bundle ([pm-3x8w4m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3x8w4m.toon))
- GH-704: make extension activation failures actionable at command and lifecycle boundaries ([pm-3ljt19](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3ljt19.toon))
- GH-705: make duplicate governance discoverable and advisory by default ([pm-de3foa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-de3foa.toon))
- GH-703: populate portable workspace coordinates in extension CommandHandlerContext ([pm-fc9gm4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fc9gm4.toon))

### Removed

- GH-708: make retained delete tombstones discoverable and policy-controlled ([pm-wdrkfr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wdrkfr.toon))

### Security

- Add TruffleHog OSS verified-secret scanning to the security workflow and complete free GitHub secret-scanning toggles ([pm-4ris](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4ris.toon))
- Refresh 2026-07-15 npm dependency updates with compatibility and release-gate proof ([pm-tll8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tll8.toon))

### Other

- CI/CD + test-suite performance: in-process CLI runner and dedupe redundant matrix legs ([pm-7rlp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7rlp.toon))
- ADR: agent identity model — stable author namespace plus structured harness, model, and session provenance ([pm-qwuber](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-qwuber.toon))
- Public SDK surface shape: 881 exports behind one flat entrypoint with no capability tiering and a 250ms eager import cost ([pm-38bskj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-38bskj.toon))
- CLI transport overhead budget: gate the per-invocation bootstrap floor and the CLI-vs-SDK delta, not just absolute scale numbers ([pm-yse5dt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yse5dt.toon))

## 2026.7.25 - 2026-07-25

### Added

- Harness-aware author identity: pm resolves the acting agent from its runtime harness so PM_AUTHOR is never required ([pm-z9x1r2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-z9x1r2.toon))
- Mutation event stream primitive: pm events --follow (NDJSON with durable cursor) + SDK subscription API for cross-process agent coordination ([pm-e200](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e200.toon))
- Create-time near-duplicate advisory: pm create/copy surface similar existing items before new work is filed ([pm-4ri6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4ri6.toon))

### Fixed

- GH-686: validate extension flag descriptors and support repeatable as a list alias ([pm-s1w0sf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s1w0sf.toon))
- GH-683: standard get projection must expose tests_count when tests are omitted ([pm-1exil1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1exil1.toon))
- GH-685: extension CommandContext needs portable source and tracker workspace coordinates ([pm-j4ac9a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j4ac9a.toon))
- GH-682: linked-test tracker sandbox must preserve source VCS workspace identity ([pm-954h0o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-954h0o.toon))
- 10k scale gate regression: CLI create latency and create/claim peak RSS exceed fixed budgets ([pm-hcrmye](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hcrmye.toon))
- PR \#673 review hardening: literal Git paths, canonical workspace identity, bounded diagnostics, and recoverable init ([pm-d7crwk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d7crwk.toon))
- GH-666/GH-667: nightly Node 22 stderr and Windows permission-contract regressions ([pm-lvd647](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lvd647.toon))
- GH-665: schema migrations need derived idempotency keys and structured recovery ([pm-s79kel](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s79kel.toon))
- GH-663: fresh init must install and surface the semantic merge fence ([pm-1w3ljt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1w3ljt.toon))
- GH-514: pm init writes no .gitignore rules — runtime/search caches churn as tracked files in downstream repos ([pm-hous](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hous.toon))
- Stale-lock takeover race in acquireLock: two waiters can both remove the stale lock and both believe they own the item ([pm-zwib](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zwib.toon))
- Create/copy ID allocation TOCTOU: duplicate generated id silently overwrites the other item's file; idExists misses extension type folders ([pm-khdq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-khdq.toon))
- GH-664: published daily release fails Bun node:sqlite verification before GitHub Release ([pm-cedo0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cedo0g.toon))

### Security

- Adopt TruffleHog 3.96.0 security action update ([pm-ion0bp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ion0bp.toon))
- Semgrep 874840488: High spawn shell true in scripts/release/utils.mjs\#L38 ([pm-a7m7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-a7m7.toon))
- Semgrep 874962820: High spawn shell true in plugins/pm-codex/scripts/pm-mcp-server.mjs\#L86 ([pm-1uul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1uul.toon))
- Semgrep 874962821: High spawn shell true in plugins/pm-claude/scripts/pm-mcp-server.mjs\#L82 ([pm-f7ik](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-f7ik.toon))
- Dependabot alert: brace-expansion unbounded expansion denial of service (GHSA-mh99-v99m-4gvg) ([pm-5q81jq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5q81jq.toon))
- Dependabot alert \#43: PostCSS previous source-map path traversal (GHSA-r28c-9q8g-f849) ([pm-a24aqt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-a24aqt.toon))
- Release pipeline permits duplicate same-day production versions ([pm-4s24d2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4s24d2.toon))

### Other

- PR \#684 post-merge deferred checks and review follow-up ([pm-e3g0h6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e3g0h6.toon))
- Execute and expose the unknown-author acknowledgment flow: dispose the five stranded events and give the shipped SDK primitive a CLI and MCP surface ([pm-zqpnte](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zqpnte.toon))
- Holistic pm CLI, SDK, and ecosystem optimization roadmap ([pm-xe0c38](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-xe0c38.toon))

## 2026.7.24-3 - 2026-07-24

### Fixed

- Same-day ordinal npm publish requires an explicit stable dist-tag ([pm-gis0qo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gis0qo.toon))

## 2026.7.24-2 - 2026-07-24

### Added

- Stale in-progress detection: validate/health flag in_progress items with no active claim or recent activity ([pm-w8q4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-w8q4.toon))

### Fixed

- Full coverage gate flakes when real all-package install exceeds generic 30-second unit timeout under load ([pm-7x0wqg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7x0wqg.toon))
- Sentry PM-CLI-2K: schema migration input error crosses CLI boundary as high TypeError ([pm-rxqcp9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rxqcp9.toon))
- Author attribution enforcement: opt-in strict unknown-author rejection, SDK test-all author parity, and audited disposition for stranded actionable events ([pm-h90s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h90s.toon))

### Security

- Write-time secret detection advisory: mutation paths flag credential-shaped content before it enters the immutable history stream ([pm-pim7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pim7.toon))

## 2026.7.24 - 2026-07-24

### Added

- pm validate needs a counts-only projection so agents can read drift numbers without row-array payloads ([pm-a9mc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-a9mc.toon))
- GH-445: suppress/factor repeated inherited tags in pm context rows (--no-tags + tag folding) ([pm-ishm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ishm.toon))
- NDJSON output mode: --format ndjson on list/search/context emits one JSON object per line for grep/jq/xargs pipelines ([pm-646c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-646c.toon))
- Workspace-scoped audit history stream: schema/config/profile/init mutations recorded as append-only hash-chained JSONL ([pm-klo8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-klo8.toon))
- Schema evolution migrations: lossless, history-recorded bulk migration of existing items when custom types, fields, or statuses are renamed or retired ([pm-dijg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dijg.toon))
- Beyond-PM SDK exemplar phase 2: temporal digital-twin graph with entity relationships, event replay, point-in-time state, and invariants ([pm-kr3t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kr3t.toon))
- Bounded SQLite metadata list reads and compact get child continuations ([pm-px153l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-px153l.toon))
- Workspace memory tiers: derived rollup summaries of closed-item epochs keep decades-old work queryable in bounded tokens ([pm-5qmm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5qmm.toon))

### Fixed

- pm deps tree must remain bounded on cyclic deep relationship graphs ([pm-gygna8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gygna8.toon))
- GH-449: contracts policy_modes advertises 'enforce' but governance config accepts 'strict' (contract drift) ([pm-kjbh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kjbh.toon))
- Scoped renderer ownership: safe package renderers should not keep isolated package doctor in warning state ([pm-nf7q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nf7q.toon))
- Extension flag value-arity decided by three divergent predicates in cli/extension-command-help.ts - help, parse, and summary surfaces can disagree ([pm-853a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-853a.toon))
- Post-install activation verification can load stale overwritten extension modules ([pm-4v4c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4v4c.toon))
- Relationship timestamp snapshots must honor event time for late and offline arrivals ([pm-j3swnb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j3swnb.toon))

### Security

- Extension install: untrusted manifest dependency specs reach npm install unvalidated (arg injection all-OS; shell command injection on Windows) ([pm-g072](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g072.toon))
- CodeQL alert 30: polynomial ReDoS in shared path normalization primitive ([pm-v3zd3o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v3zd3o.toon))

### Other

- SDK reference documentation for promoted primitives + migration notes for the CLI-on-SDK layering ([pm-ds3b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ds3b.toon))
- SDK authoring DX polish: manifest-drift guard in scaffold tests, expectation key naming, repeated --capability, define\* index signatures ([pm-llrp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-llrp.toon))
- Extension install should scaffold newly required item-type folders (pm health ok:false after installing pm-kanban until pm init) ([pm-l98s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l98s.toon))
- Cursor fingerprints: replace per-command presentation-flag deny-lists with contract-declared semantic classification in sdk/pagination ([pm-fgih](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fgih.toon))

## 2026.7.23 - 2026-07-23

### Added

- SDK relationship registry and graph-query primitives: custom typed edges, adjacency, paths, closures, impact, and bounded subgraphs ([pm-ju83](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ju83.toon))
- Context relevance signal feature store: derived recency, graph, claim, risk, deadline, knowledge-density, and semantic-match signals ([pm-3hps](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3hps.toon))

### Fixed

- GH-646: classify merge reconciliation discards by net outcome ([pm-mmm9o5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mmm9o5.toon))
- GH-649: reject self-referential ordering relationships at the SDK mutation boundary ([pm-k9t17l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-k9t17l.toon))
- GH-645: standard-depth get/show JSON omits notes without notes_count ([pm-3esl28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3esl28.toon))
- GH-638: delete JSON envelope reports the removed item as open ([pm-tz2ikr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tz2ikr.toon))
- GH-635: plan create cannot forward strict Plan-required metadata ([pm-qd3woa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qd3woa.toon))
- GH-642: linked-test runner enters interactive init wizard before repository commands ([pm-lcnk2n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lcnk2n.toon))
- GH-641: plan link promotion rejects registered implements relationship kind ([pm-ypuc39](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ypuc39.toon))

### Other

- Capstone: zero the SDK import-boundary baseline — flip remaining CLI/MCP private-core imports to SDK primitives and harden the ratchet into a hard boundary gate ([pm-9x6e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9x6e.toon))

## 2026.7.22 - 2026-07-22

### Fixed

- Sentry PM-CLI-2G: make merge-driver installation permission failures actionable ([pm-bnmlsc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bnmlsc.toon))
- Sentry PM-CLI-2F: classify manifest-proven torn bundle call-time TypeError ([pm-pz7xtx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pz7xtx.toon))
- Compatibility gate rejects compact legacy create envelopes after release promotion ([pm-pkdpyz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pkdpyz.toon))
- Sentry PM-CLI-2E: directory-shaped settings.json crashes CLI bootstrap ([pm-k0nl2w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-k0nl2w.toon))
- Sentry PM-CLI-2D: storage-integrity history scan reads .jsonl directories as files ([pm-o1c53b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-o1c53b.toon))
- GH-576: unknown-command help probes return structured non-zero errors ([pm-bu1m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bu1m.toon))
- GH-551: dependency seeds accept global source_kind and preserve cross-workspace IDs ([pm-topu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-topu.toon))
- GH-595: list JSON always emits total/has_more/truncated/next_cursor and omits unset filters ([pm-wrss](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wrss.toon))
- GH-623: opt-in post-merge history reconciliation hook and one-command verify repair ([pm-mfkv92](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mfkv92.toon))
- GH-553/GH-584: CodeFactor unnecessary-spread findings — restructure flagged spread sites (class owner) ([pm-zt1c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zt1c.toon))
- GH-574: flattened extension alias subcommands still drop option contracts after GH-503/GH-550 fixes (empty --help, valid options rejected as positionals) ([pm-7ufz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7ufz.toon))

### Security

- Dependabot alert \#42: brace-expansion CPU denial of service (GHSA-3jxr-9vmj-r5cp) ([pm-f5hy2n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-f5hy2n.toon))

### Other

- GitHub analyzer follow-up: GH-628 unnecessary spread, GH-629 duplicate blocks, and GH-630 unsafe optional chaining ([pm-aw59hb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-aw59hb.toon))
- GH-582: runRegisteredListCommand flagged Complex Method by CodeFactor — extract option-assembly helpers in register-list-query.ts ([pm-zwya](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zwya.toon))

## 2026.7.21 - 2026-07-21

### Added

- Graph planning & structural analytics: critical-path slack, betweenness/closeness centrality, and articulation points/bridges ([pm-efuo34](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-efuo34.toon))
- CLI+MCP surface for atomic bulk item mutations: JSON mutation batch on stdin over commitItemMutations ([pm-xm7c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xm7c.toon))
- GH-438: accept a full item JSON document on stdin for pm create / pm update ([pm-kipd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kipd.toon))
- GH-435: lean JSON output mode omitting null/empty fields (~50% token cut for --json) ([pm-cfed](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cfed.toon))
- GH-437: make lean mutation output the CLI default (parity with MCP compact envelope) ([pm-nilh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nilh.toon))
- GH-443: lean error mode — drop constant required/why boilerplate from structured errors ([pm-g9xk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-g9xk.toon))

## 2026.7.20 - 2026-07-20

### Added

- Tracker merge semantics: field-aware merge guidance, history-chain-safe JSONL merging, and post-merge reconciliation for multi-branch agent workflows ([pm-g5sx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-g5sx.toon))
- GH-613: public SDK bulk item-mutation helper on commitWorkspaceTransaction — atomic create/update/close batches without hand-rolled step+compensation wiring ([pm-y9hq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-y9hq.toon))
- GH-612: additive --add-ac/--remove-ac forms for acceptance criteria — replace-only --ac clobbers concurrent branch edits ([pm-xh82](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xh82.toon))
- GH-599: git merge driver + documented workflow for append-only history/\*.jsonl (concurrent appends fork the hash chain) ([pm-wc1r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-wc1r.toon))

### Fixed

- Merge-driver fence completeness: relationships/\*.jsonl event stores uncovered and schema-added custom type folders silently drop driver coverage ([pm-i4fx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i4fx.toon))
- MERGE_SAFETY.md documented an invalid config invocation: 'pm config set project ids.token_length 6' exits 2 (scope must precede the verb) ([pm-46octv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-46octv.toon))
- GH-601: SDK mutation option bags and projected list items are Record<string,unknown\> — typos and wrong types compile clean under strict ([pm-x29o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x29o.toon))
- GH-600: item id generation not collision-safe across branches/concurrent agents (4 base36 chars, local-disk-only uniqueness) ([pm-pibw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pibw.toon))
- GH-615: pm notes --message without content is a silent no-op — apply the GH-588 empty-comment guard to the notes twin ([pm-iedg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-iedg.toon))
- GH-602: SDK .d.ts require @types/node but package does not declare it — tsc errors inside node_modules for consumers; plus shipped JSDoc defects ([pm-n1xx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-n1xx.toon))
- GH-596: update-many --ids must report nonexistent requested IDs ([pm-ukml](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ukml.toon))
- GH-597: reject empty append text without false updated_at freshness ([pm-d9g9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d9g9.toon))
- Nightly macOS+Windows red post-PR\#568: staging-base selection compares realpath'd source against non-canonical temp dir — staging lands inside source, fs.cp EINVAL self-copy ([pm-hvt3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hvt3.toon))
- fix: nightly windows/Node24 red — vcs-extension spec asserts POSIX 'relationships/events.jsonl' against native default store path ([pm-34yf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-34yf.toon))
- GH-607: validate reports ok:true / checked_items:0 on structurally-unparseable item .toon — silently skips what pm get hard-errors on ([pm-cxyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cxyv.toon))
- GH-598: pm init .gitignore block hardcodes .agents/pm/ prefix — custom-root workspaces commit runtime cache and conflict on every merge ([pm-4uqm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4uqm.toon))

### Other

- Adopt collision-resistant id entropy in the pm-cli repository (ids.token_length 4 -\> 6) ([pm-88cy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-88cy.toon))
- Adopt PR\#614 merge safety in the pm-cli repository itself: pm merge install, committed .gitattributes fence, CI storage-integrity + strict history-verify gates, transactions GC schedule ([pm-iwsj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-iwsj.toon))

## 2026.7.19 - 2026-07-19

### Added

- Public SDK transaction boundary: atomic multi-item + relationship-event commit primitive ([pm-4e12](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4e12.toon))
- Beyond-PM SDK exemplar spike: minimal VCS-style changeset workflow as a pm package (custom schema + event-sourced history + hooks) ([pm-xtrd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xtrd.toon))

### Fixed

- Workspace-transaction journals: .agents/pm/transactions/ outside the init gitignore block with no retention or GC ([pm-8xod](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8xod.toon))
- GH-609: settings.json/schema/\*.json have no merge driver; validate reports ok:true by silently falling back to defaults on unparseable config ([pm-xdn6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xdn6.toon))
- GH-611: delete/modify merge silently resurrects deleted items and leaves conflict markers in history/\*.jsonl while validate stays green ([pm-wwfd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wwfd.toon))
- GH-604: pm history <id\> --verify exits 0 when verification.ok is false; no --strict-exit — unusable as a merge-safety gate ([pm-ol3p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ol3p.toon))
- GH-608: concurrent edits to different fields always conflict on the shared updated_at scalar (no field-level .toon merge) ([pm-m3nl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m3nl.toon))
- GH-603: history-repair cements cross-author data loss after a lossy merge — reverting patch discards the other author's mutation, validate fully green ([pm-gpo7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gpo7.toon))
- GH-606: concurrent note/tag appends hard-conflict the .toon item file; stale count headers corrupt the item beyond parsing ([pm-9q2t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9q2t.toon))
- GH-588: pm comment --message exits 0 recording nothing — comment invocation without any comment text must fail fast ([pm-yp56](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yp56.toon))
- GH-589: pm next --assignee X answers from anonymous-caller perspective and pm claim conflates assignment with claim ([pm-cj9v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cj9v.toon))
- GH-591: pm context agenda events re-embed full item payloads already listed in the same response (~35% of brief output) ([pm-6m1i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6m1i.toon))
- GH-592: tracker_not_initialized recovery re-suggests pm init even when a --pm-path tracker exists — following it silently splits workspace state ([pm-tmhs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tmhs.toon))
- GH-586: graph audit severity and code summaries mix finding and affected-item units ([pm-um4g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-um4g.toon))
- GH-590: cycle-creating blocked_by mutations succeed silently — items deadlock out of pm next with no inline feedback ([pm-i6pi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i6pi.toon))
- GH-585: extension alias collision diagnostics for core command groups ([pm-v1yo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v1yo.toon))

## 2026.7.18 - 2026-07-18

### Fixed

- MCP nested options accept unknown keys silently (pm_deps options.dep no-ops) — extend pm-qxwu top-level warning into options objects ([pm-upi0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-upi0.toon))
- Sentry PM-CLI-2C: classify Node MaxListeners runtime warnings as warning-level diagnostics ([pm-qpfv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qpfv.toon))
- GH-578: align pm context and pm list-blocked with edge-aware pm next semantics ([pm-uxkf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-uxkf.toon))
- pm deps context format reports missing_count without enumerating missing references and disagrees with tree format ([pm-8kch](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8kch.toon))

### Security

- CodeQL alert 27: js/polynomial-redos in sdk/test/linked-command-detection.ts trailing-dash prefix trim ([pm-8og4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8og4.toon))

## 2026.7.17 - 2026-07-17

### Added

- SDK-only exemplar: minimal custom PM CLI package proving the universal-tool story end-to-end ([pm-cbwg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cbwg.toon))
- Promote execution and diagnostics primitives to the public SDK: linked-test running and test-run lifecycle, search eval harness, telemetry stats/export ([pm-oslr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oslr.toon))

### Fixed

- cli/main.ts commander program is a module-level singleton: dynamically registered extension commands/flags persist across in-process invocations ([pm-qfdd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qfdd.toon))
- Windows packed-extension install regression exceeds the generic Vitest timeout ([pm-ph3i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ph3i.toon))

## 2026.7.16 - 2026-07-16

### Other

- 2026-07-15 full CLI SDK and ecosystem manual audit and optimization plan (review pass 91) ([pm-45lr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-45lr.toon))

## 2026.7.15 - 2026-07-15

### Added

- Promote governance, validation, health, and maintenance primitives to the public SDK: validate, health, gc, changelog/reporting hooks ([pm-oxrw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oxrw.toon))
- GH-444: ergonomic author attribution — global --author, init author_default, unknown-author advisory ([pm-cpja](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cpja.toon))
- Promote schema, config, profile, and init primitives to the public SDK: full workspace customization programmatically ([pm-3mna](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3mna.toon))
- Promote package & extension lifecycle primitives to the public SDK: install, upgrade, extension list/enable/disable, managed-package state ([pm-x6jf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-x6jf.toon))
- Promote annotation and link primitives to the public SDK: comments, notes, learnings, files, docs, deps, append metadata ([pm-zwpp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zwpp.toon))
- Point-in-time read projection: pm get --at <version\|timestamp\> renders reconstructed historical item state without mutating ([pm-hib1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hib1.toon))

### Fixed

- Linked-test item reference parser skips item IDs after value-bearing flags ([pm-jhg9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jhg9.toon))
- Sentry PM-CLI-2B: external extension subprocess cannot resolve pm executable ([pm-d4ns](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d4ns.toon))
- Sentry PM-CLI-29: external Neo4j command reports missing configuration as a high pm-cli error ([pm-7n5a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7n5a.toon))
- Nightly windows/Node24: package-manifest SDK-surface exemption uses POSIX endsWith — governance-audit runtime.ts check fails on backslash paths ([pm-u5zr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u5zr.toon))
- GH-522: Windows nightly red — init next-steps hints POSIX-quote native Windows paths (quoteCommandArg backslash escaping) ([pm-b24b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b24b.toon))
- GH-567: macOS+Windows nightly red — extension-install copy self-nesting check misses symlinked/short-name temp paths (realpath fallback asymmetry) ([pm-0fhw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0fhw.toon))
- Adopt CodSpeed continuous CPU benchmarking in CI: review/land PR\#564 and establish the per-PR perf-regression signal ([pm-yh6t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yh6t.toon))
- GH-562: pm init rejects --id-prefix/--prefix flag though id prefix is only positional ([pm-nmzx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nmzx.toon))
- GH-560: extension renderer overrides diverge between SDK harness and real CLI output ([pm-as4a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-as4a.toon))
- GH-557: contract layer intercepts -h/--help before variadic-positional handlers, blocking legitimate positional content ([pm-albl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-albl.toon))
- GH-547: SDK exporters and renderers cannot suppress host rendering of handled output ([pm-f38n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-f38n.toon))
- GH-550: extension list flags are erased at the real CLI boundary ([pm-evav](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-evav.toon))
- GH-558: export canonical item-to-context-relevance candidate derivation from the public SDK ([pm-qyc6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qyc6.toon))
- GH-555: remove unnecessary spread in relationship registry ordering assertion ([pm-ofgc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ofgc.toon))
- Validate lifecycle cycles using ordering relationship kinds only ([pm-6irg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6irg.toon))

### Security

- Add OSSF Scorecard supply-chain security workflow with published results and SARIF code-scanning upload ([pm-k7dp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k7dp.toon))

### Other

- validate_history_unknown_author_events: legacy/actionable split for immutable unknown-author history events + first-party automation author coverage ([pm-demq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-demq.toon))
- Ship DeepSource, DeepScan, and Scrutinizer CI free-OSS analyzer configurations with documented activation ([pm-3a68](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3a68.toon))
- ADR: relationship graph semantics — typed directional, ordering, provenance, evidence, and associative edges with schema-extensible invariants ([pm-4jqm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-4jqm.toon))

## 2026.7.14 - 2026-07-14

### Added

- Promote history-stream maintenance primitives to the public SDK: history-redact, history-repair, history-compact (audited rewrite, re-anchor, checkpoint/prune) ([pm-4a7m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4a7m.toon))
- Context usage feedback signal: served-then-acted-on outcomes strengthen relevance scoring (retrieval-practice effect) ([pm-uwfs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-uwfs.toon))

### Changed

- Replace obsolete front-matter vocabulary with item metadata terminology ([pm-hq28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hq28.toon))

### Fixed

- pm get --full omits children for Plan parents while pm list --parent returns them ([pm-y4z5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-y4z5.toon))
- Intentional package CommandError outcomes create high-severity Sentry issues (PM-CLI-16) ([pm-7071](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7071.toon))
- Extension install self-copy guard: reject source-inside-destination layouts before fs.cp EINVAL (PM-CLI-28) ([pm-8myl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8myl.toon))
- Sentry captures deliberate Ctrl+C interrupts as error-level events (AbortError, PM-CLI-27) ([pm-ksv2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ksv2.toon))
- Torn-install bundle transients block scheduled releases: boot-time chunk-integrity self-check + distinct error code for gate classification ([pm-wfvq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wfvq.toon))
- GH-446: pm get omits schedule facet (events/start_at/end_at/location) for Meeting/Event/Reminder ([pm-x1g5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x1g5.toon))
- GH-533: create/update accept empty --title — required-title contract inconsistent between omitted and empty string ([pm-7je0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7je0.toon))
- GH-535: pm deps omits dangling parent references (missing_count:0, missing:false) contradicting validate's dangling_reference_count ([pm-p9sc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p9sc.toon))
- GH-542: MCP pm_copy nests title/message under options while sibling tools declare flat camelCase params — own suite triggers unexpected-arg warnings ([pm-hno5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hno5.toon))
- GH-532: --estimated-minutes accepts negative numbers and floats — missing non-negative-integer range validation ([pm-jh9t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jh9t.toon))
- GH-534: no-op update reports phantom changed_fields in --json while TOON reports empty, and changed_field_count is always null in JSON ([pm-45mb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-45mb.toon))
- GH-526: aggregate --sum/--avg accept unknown field names and silently report 0 ([pm-96vo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-96vo.toon))
- GH-530: list --status <invalid\> silently returns count 0 — validate against the status domain like --type and search status: ([pm-kj4k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kj4k.toon))
- GH-544: linked-file path anchoring — files/docs add/glob/discover/validate-paths resolve at process.cwd() while validate --check-files anchors at the workspace root ([pm-chyh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-chyh.toon))
- Separate active dangling dependency warnings from terminal historical reference diagnostics ([pm-2ler](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2ler.toon))

### Other

- Docstring coverage regressed below achieved-100% by PR\#536 extraction files; quality:static floors never ratcheted and mask drift; drop dead closure-pattern export ([pm-fb3i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fb3i.toon))
- PR review helper: watch GitHub checks and enforce thread-scoped replies ([pm-0fxa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0fxa.toon))
- Token-budget context packer: diversity-aware selection, projection degradation, and bounded output for pm context/next ([pm-55ra](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-55ra.toon))
- Complete public linked-resource SDK primitives and actionable dependency governance ([pm-jcvg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jcvg.toon))

## 2026.7.13 - 2026-07-13

### Added

- Bare-core audit extraction phase 2: move audit command implementations and audit flags out of default CLI/SDK into pm-governance-audit ([pm-vjk3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vjk3.toon))
- Cursor pagination and bounded-output defaults for list/search/context at scale ([pm-dfg0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dfg0.toon))
- Notes/learnings repair parity: add --edit/--delete (and a real --stdin/--file input source) matching comments, so bad annotation entries are fixable via the CLI ([pm-a2h3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a2h3.toon))

### Changed

- S3: move the --allow-audit-\* override flag family out of core command registrations into pm-governance-audit (enforcement stays core) ([pm-7dcf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7dcf.toon))
- S2: move the --audit linked-usage report mode off pm files/pm docs into pm-governance-audit ([pm-27mv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-27mv.toon))
- S1: relocate dedupe-audit/dedupe-merge/comments-audit/normalize implementations into pm-governance-audit and delete their public SDK exports ([pm-79fr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-79fr.toon))

### Fixed

- Runtime-extension snapshot caches go stale in long-lived in-process embeddings (install invisible to next invocation) ([pm-8fxc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8fxc.toon))
- GH-518: reduce Complex Method in src/cli/commands/next.ts (CodeFactor, PR\#517 rank rendering) ([pm-2gvp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2gvp.toon))

### Other

- Extract governance audit runtime from the default CLI and SDK ([pm-w1c0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-w1c0.toon))
- S5: coverage migration + bare-core vs installed-plugin e2e verification for the audit extraction ([pm-rxp1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rxp1.toon))
- S4: purge audit surface from default SDK contracts, MCP tool definitions, completion, help, and docs; package declares its own contracts; re-measure token surface ([pm-kg18](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kg18.toon))
- Promote terminal-status and mutation runner primitives required by package-owned governance workflows ([pm-yu6d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yu6d.toon))
- Decision: extension-point mechanism and bare-core fallback semantics for extracted audit flags (D1+D2 of pm-vjk3) ([pm-fg0b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-fg0b.toon))
- Scale benchmark harness: synthetic 10k/100k/1M-item workspace generator + latency/memory/token baseline for the read and claim hot paths ([pm-mi2x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mi2x.toon))
- Lazy-load @sentry/node off the command hot path (~850ms ESM load on every command, even when telemetry disabled) ([pm-1ybs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1ybs.toon))
- ADR: workspace scale-out strategy — indexed reads, storage fan-out, and bounded-output contracts for 100k-1M-item workspaces (proposed) ([pm-bl8x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-bl8x.toon))
- Local test/coverage dev loop 17+min: replace per-call spawnSync CLI runner with synchronous worker-thread bridge ([pm-kvd0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-kvd0.toon))

## 2026.7.12 - 2026-07-12

### Added

- Promote plan workflow primitives to the public SDK: plan create/steps/dependencies/decisions/discoveries/validation/materialization ([pm-je50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-je50.toon))

### Fixed

- Restore 100% SDK workspace read-error coverage ([pm-jw2a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jw2a.toon))
- GH-510: macOS nightly red — withTempPmPath skips realpath canonicalization; init-path-guard probe-root assertion fails (/var vs /private/var) ([pm-dprb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dprb.toon))
- GH-454: schema add-field accepts reserved built-in names silently; collision error names no partner ([pm-b9ov](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b9ov.toon))
- GH-516: pm init seeds unrelated managed packages into fresh PM_GLOBAL_PATH workspaces ([pm-b0se](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b0se.toon))
- GH-448: boolean custom field is silently never persisted (data-loss class) ([pm-sjfs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sjfs.toon))
- GH-509: pm claim --next lacks candidate filters and race-loss walk — thread next filters + advance to next candidate ([pm-fjxm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fjxm.toon))
- Prevent Decision items from entering agent work lanes by default; allow explicit maintainer opt-in ([pm-eqk0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eqk0.toon))
- GH-513: pm next ready\[\] documented as ranked but not priority-ordered; no rank/score exposed ([pm-1mwk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1mwk.toon))
- Fix red main coverage gate: measure-agent-token-surface.mjs landed without a covering spec ([pm-ksca](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ksca.toon))
- GH-508: dedupe LegacyNoneCollectionNormalizer tables duplicated between create.ts and update.ts (CodeFactor) ([pm-zuw8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zuw8.toon))
- Release-readiness guard expects pre-sync version:check command after date-version synchronization ([pm-pmmv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pmmv.toon))
- Restore generated-loader docstrings and redact host path from tracker history ([pm-9ugc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9ugc.toon))
- Full coverage contention times out metadata content-filter integration case ([pm-d30l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d30l.toon))
- GH-453: plan materialize --json response omits title/type/parent on materialized entries ([pm-ypha](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ypha.toon))
- GH-452: plan materialize dead-ends on types with required-on-create custom fields ([pm-qd2h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qd2h.toon))
- GH-507: recovery suggested_retry appends <value\> to missing boolean EXTENSION flags (contract arity ignored) ([pm-9qcr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9qcr.toon))
- GH-505: nested extension failures suggest irrelevant missing flags instead of preserving tracker recovery ([pm-o71e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-o71e.toon))
- GH-504: importer/exporter registered without options yields an unusable CLI command (no arg/flag contracts) ([pm-0mjz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0mjz.toon))
- GH-503: flattened extension-command aliases (csv-export, jira-sync) drop option contracts ([pm-s9iu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s9iu.toon))

### Other

- Coverage to 100%: src/core, src/mcp, and src/sdk modules ([pm-krwu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-krwu.toon))
- Baseline agent token cost of the CLI surface: measure pm --help, per-command help, and contracts payload sizes before consolidation ([pm-a22j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-a22j.toon))
- Research and document the July 2026 native ChatGPT/Codex plugin implementation plan ([pm-n28t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-n28t.toon))
- Align all plugin and package manifests to date-based versioning with release-time sync ([pm-hxsv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hxsv.toon))

## 2026.7.11 - 2026-07-11

### Added

- pm claim --next: atomically claim the next actionable item so parallel agents each get distinct work ([pm-114v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-114v.toon))

### Fixed

- Dangling dependency references: accepted at create/update, skipped by validate, and treated as satisfied by pm next (silent unblock) ([pm-ol5v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ol5v.toon))
- Classify tracker-not-initialized Sentry CommandErrors as expected handled CLI errors ([pm-w7jq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-w7jq.toon))
- GH-498: pm comments rejects --body — accept it as an alias for --add and hint on unknown options ([pm-z32q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-z32q.toon))
- GH-500: suggested_retry renders boolean flags with a "<value\>" placeholder — literal suggestion fails ([pm-6y58](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6y58.toon))
- pm next repeats the recommended item verbatim as ready\[0\] — emit an id reference instead ([pm-hfg5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hfg5.toon))
- pm next recommends another agent's assigned in_progress item as 'resume to finish' — recommendation must be caller-aware ([pm-yl6c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yl6c.toon))
- GH-489: pm next summary reports blocked: 0 while blocked items exist — blocked companion list missing ([pm-l0bu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l0bu.toon))
- GH-501: pm init <path\> roots a tracker that workspace discovery cannot find — tracker_not_initialized loop right after init ([pm-69nl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-69nl.toon))
- GH-496: extension flags declared list:true don't accumulate repeated occurrences — host maps to scalar, Commander last-wins drops values ([pm-kfq5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kfq5.toon))
- Reserved item-field name collisions are invisible to SDK lint/preflight/harness ([pm-ghf1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ghf1.toon))
- Repeated --ac flags on create/update silently keep only the last acceptance criterion ([pm-b84u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b84u.toon))
- GH-497: pm create --template silently drops tags and custom type-option fields — only built-ins (priority/assignee) apply ([pm-l6rz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l6rz.toon))
- pm create/update --dep silently normalizes malformed shorthand into dangling dependency ids (related:pm-x26a -\> pm-related:pm-x26a) ([pm-zazb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zazb.toon))
- contracts-snapshot gate is environment-dependent: fixture baked in installed-extension contracts, failing CI on extension version drift or absence ([pm-zcjy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zcjy.toon))
- GH-495: extension context pm_root ignores root-layout trackers (falls back to non-existent .agents/pm) ([pm-kvev](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kvev.toon))
- pm close never stamps closed_at, so changelog and release-notes bucketing always falls back to updated_at ([pm-m4iu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m4iu.toon))

### Other

- Repo-wide 100% docstring coverage: public API + data contracts (gate-enforced) ([pm-4ak1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-4ak1.toon))
- Docstring gate: extend static-quality-gate to enforce public-API + data-contract coverage repo-wide ([pm-5566](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5566.toon))
- Docstrings: src/types (shared data model interfaces + consts) ([pm-uxmf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uxmf.toon))
- Docstrings: src/sdk (public SDK surface + cli-contracts) ([pm-uwu0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uwu0.toon))
- Docstrings: packages/\* (module docs + exported/public surface for all 11 shipped packages) ([pm-qely](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qely.toon))
- Docstrings: src/core/extensions (extension-types + loader/runtime contracts) ([pm-mswi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mswi.toon))
- Docstrings: src/cli/commands (largest surface — command option/result interfaces) ([pm-m0uc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m0uc.toon))
- Docstrings: src/core (search, schema, test, history, telemetry, governance, store, item, and remaining core modules) ([pm-768v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-768v.toon))
- Docstrings: src/cli (non-commands), src/mcp, src/ root modules ([pm-2vb2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2vb2.toon))
- Untrack vendored pm-changelog extension dist from git (installed npm artifact, restored by changelog:pm:install) ([pm-sod3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-sod3.toon))
- Refresh CodeQL Actions and reject incompatible Node 26 type-contract bump ([pm-2a9n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2a9n.toon))

## 2026.7.10 - 2026-07-10

### Added

- GH-473: pm install prints a post-install verification summary ([pm-yjim](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yjim.toon))

### Fixed

- Sentry release gate misclassifies handled duplicate-import refusal as a blocking runtime error ([pm-io4t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-io4t.toon))
- GH-488: path-target pm init emits executable tracker-scoped follow-up commands ([pm-x26a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x26a.toon))
- Declarative extension install: activation failure is misreported and scaffold next_steps break when @unbrained/pm-cli is unresolvable ([pm-3wsi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3wsi.toon))
- Project package install with --pm-path can write extensions into the caller workspace ([pm-qt5d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qt5d.toon))
- GH-482: Node 24 nightly coverage gate flake — readdir-order-dependent branch at front-matter-cache.ts:505 ([pm-gume](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gume.toon))
- Context evaluation runner and CI gate: rank-aware quality metrics plus token-budget regression checks ([pm-xmp5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xmp5.toon))
- Token-cost regression gate: CI budget check over a representative command-output corpus ([pm-cu1i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cu1i.toon))
- GH-484: pm update --blocked-by silently overwrites prior blockers instead of appending ([pm-q6gx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-q6gx.toon))
- GH-485: pm search rewrites quoted status:all hybrid queries into --status and drops keywords ([pm-2ldo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2ldo.toon))

### Other

- Pre-install package-owned command names should hint the owning package install command ([pm-b3e9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b3e9.toon))
- Context relevance scorer contract: pluggable SDK weighting, deterministic default model, and extension override path ([pm-h3no](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h3no.toon))

## 2026.7.9 - 2026-07-09

### Added

- GH-442: lean pm contracts --summary mode for cheap agent bootstrap (25KB -\> 1-3KB) ([pm-vxxm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vxxm.toon))
- GH-470: pm list --today and --recent shorthand filters for recently active items ([pm-bfma](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bfma.toon))

## 2026.7.8 - 2026-07-08

### Added

- GH-474: pm search --limit support in hybrid mode ([pm-alnj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-alnj.toon))
- GH-467: isolated package/extension diagnostics — project-scoped doctor and smoke tests without global pm state leaking in ([pm-6abs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6abs.toon))

### Fixed

- Triage: close GH-455 with shipped evidence once the Ollama embedding auto-default fix releases ([pm-hq0r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-hq0r.toon))

### Other

- Expose sentry telemetry gate as package script alias ([pm-w86l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-w86l.toon))
- Expose package lifecycle primitives through public SDK helpers ([pm-kffw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kffw.toon))
- ADR: 2026-06-07 deep review + remediation pass (never-block, MCP/version coherence, docs/CI hardening) ([pm-96wm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-96wm.toon))
- GH-476: pm context rejects --max-items with an untargeted unknown_option (alias or recovery hint) ([pm-5h9g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5h9g.toon))

## 2026.7.7 - 2026-07-07

### Added

- Promote query/read primitives to the public SDK: list, get, search, context, next, aggregate, stats ([pm-rjqr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rjqr.toon))
- Promote item lifecycle primitives to the public SDK: create, update, close, claim/release, copy, delete, restore, focus ([pm-98cz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-98cz.toon))

### Fixed

- Relative lancedb vector-store path resolves against process cwd, creating nested .agents/pm/.agents/pm stores ([pm-og1v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-og1v.toon))
- Annotation --add silently stores flag-like tokens as content: pm notes <id\> --add --stdin records the literal note "--stdin" ([pm-vcu7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vcu7.toon))
- pm plan create silently ignores the root --id-only flag (prints full plan envelope) ([pm-oz0k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oz0k.toon))
- GH-427: Windows Node 24 nightly fails — POSIX-only error-code assertions (EACCES/EISDIR) in restore-command and history-rewrite specs ([pm-lt6n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lt6n.toon))
- pm extension --install pm-<alias\> / @unbrained/pm-<alias\> fails with 'Local extension source does not exist' instead of suggesting the bundled catalog alias ([pm-jqd2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jqd2.toon))
- GH-455: pm health auto-selects an uninstalled Ollama embedding model then fails vector refresh ([pm-aems](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-aems.toon))
- GH-463: linked PM tracker-read tests should auto-remediate or suggest --auto-pm-context ([pm-6e1d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6e1d.toon))
- SDK client.run() rejects structured payloads for create: raw {type,title} fails with 'Missing required option --title' ([pm-395t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-395t.toon))
- Bare extension command group (pm changelog / pm graph) exits 0 with zero output instead of rendering group help ([pm-1k57](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1k57.toon))

### Other

- 2026-07-07 ecosystem audit \#16: all-status review, long-horizon gap items (merge semantics, event stream, policy roles, flow metrics) ([pm-su60](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-su60.toon))
- chore: 2026-07-06 ecosystem audit \#13 — Semgrep-issue metadata backfill, scale-out initiative pm-9rxu, composability contract set ([pm-lgim](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-lgim.toon))
- chore: 2026-07-06 ecosystem audit \#14 — WIP status hygiene (docstring family reset) + stale in-progress detection backlog ([pm-6a1g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6a1g.toon))
- 2026-07-06 ecosystem audit \#12: GH-467..474 backlog coverage + code-scanning capability epic ([pm-3rgp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3rgp.toon))
- 2026-07-06 ecosystem audit \#15: WIP hygiene, GH/commit coverage verification, grammar+SDK domain completions, horizon-4 planning ([pm-pvij](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-pvij.toon))
- Triage: close stale dogfood reports GH-436 (pm next/focus) and GH-440 (context --fields) with shipped evidence ([pm-7cx8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7cx8.toon))
- GH-458: claim/start-task reject --assignee with an untargeted recovery hint (alias or better hint) ([pm-qfte](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qfte.toon))
- pm install should accept multiple package targets (help already advertises \[targets...\]) ([pm-hj9h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hj9h.toon))
- Unblock dependabot PRs: @types/node 26 type error, pnpm release-age cooldown, codeql-action lockstep group ([pm-2czc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2czc.toon))
- GH-468: clarify or publish the pm SDK npm package coordinates (@unbrained/pm-sdk is 404) ([pm-25d0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-25d0.toon))

## 2026.7.6 - 2026-07-06

### Added

- Expose SDK runAction and PmClient execution surface for programmatic integrations ([pm-xzhz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xzhz.toon))

### Other

- ADR: the pm SDK is the single public API — CLI and MCP are presentation layers (proposed) ([pm-muhw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-muhw.toon))

## 2026.7.5 - 2026-07-05

### Added

- Architecture boundary ratchet: prevent new CLI/MCP private core imports while SDK promotion shrinks the baseline ([pm-8778](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8778.toon))
- Lock contention auto-retry: bounded jittered wait before lock_conflict so parallel agent mutations self-heal ([pm-2muu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2muu.toon))

### Fixed

- Extension installs are dead-on-arrival in CommonJS host projects: installed extension dirs lack package.json type:module ([pm-r0m4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r0m4.toon))
- beads/todos import-export runtime broken from real npm installs: runtime-loader imports .ts under node_modules (type-strip refused) ([pm-ejy7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ejy7.toon))
- pm close <id\> -m 'text' still hard-blocks with close_reason_required: accept --message text as close-reason fallback (like closed pm-7x8d did for --resolution) ([pm-9hry](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9hry.toon))
- pm claim silently steals items already assigned to another agent — claim must be atomic test-and-set for multi-agent work distribution ([pm-8t5x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8t5x.toon))
- Extension activation adds ~200ms to every command when bundled packages are installed ([pm-4oww](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4oww.toon))

### Other

- Backfill full-context bodies (and comments/deps/risk) on all active items so context is rebuildable from pm CLI alone ([pm-o043](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-o043.toon))
- 2026-07-04 full pm-backlog audit: reconcile pm items with entire ecosystem (code, tests, docs, ideas, decisions) ([pm-y904](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-y904.toon))
- 2026-07-04 ecosystem audit \#4: coverage matrix, governance capability epic & relationship modeling ([pm-osea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-osea.toon))
- Bundle GH-433 self-parent guard, Windows nightly lock proof, and pnpm 11 bootstrap hardening ([pm-q1ke](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-q1ke.toon))
- Inventory the CLI-to-core call graph: map every command to core modules and classify logic for SDK promotion ([pm-lodl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lodl.toon))
- Sandbox audit fixes: package describe accepts npm package name; pm context <id\> routes to pm get ([pm-ayn7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ayn7.toon))
- SDK testing-helper input validation: runRegisteredCommandForTest positional misuse crashes; createExtensionTestHarness accepts non-extension module silently ([pm-2exf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2exf.toon))
- GH-426: reduce complex method in compatibility-check.spec runCurrentPmCommand ([pm-24o5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-24o5.toon))

## 2026.7.4 - 2026-07-04

### Security

- Extreme mandatory quality gates: strict ESLint everywhere, jscpd strict/zero-threshold, suppressions budget, Trivy/ShellCheck/PSScriptAnalyzer/actionlint CI, admin-proof branch protection ([pm-7wmq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7wmq.toon))

### Other

- Test meaningfulness audit: strengthen hollow assertions, de-mock thin specs, convert contract source-mirrors to behavior ([pm-4i73](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4i73.toon))

## 2026.7.3 - 2026-07-03

### Fixed

- GH-416: Windows nightly validate linked-artifact prune classification ([pm-xpkt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xpkt.toon))

### Other

- Perf: pm context / pm next hot path ~700ms on an ~850-item tracker ([pm-z1pv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z1pv.toon))
- 2026-07-02 full ecosystem audit & optimization pass (CLI+SDK+packages+docs+CI) ([pm-fpod](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fpod.toon))
- Zero the jscpd clone baseline: dedupe registration-helpers/flag-contracts source clones and 21 test-spec clones ([pm-chxp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-chxp.toon))
- Lane E: Docs audit (progressive disclosure, minimal README, link graph, duplicated docs/skills) ([pm-p99b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p99b.toon))
- Lane F: CI/CD best-practice + secret/PII leak scan incl. pm history files ([pm-mo2v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mo2v.toon))
- Lane A: E2E ecosystem smoke in temp workspace (pack+install CLI, all first-party packages, full command surface, agent UX/token-efficiency) ([pm-kes3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kes3.toon))
- Lane C: Code quality audit (complexity, dead code, cross-file duplication, long files, type safety, dependencies) ([pm-hfli](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hfli.toon))
- CodeFactor residual complexity and duplication cleanup for 27-issue main snapshot ([pm-bssk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bssk.toon))
- Lane B: SDK best-practice + package-authoring DX review (define/compose/harness/preflight loop, scaffold matrix) ([pm-6vy7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6vy7.toon))
- Lane D: Performance audit (startup latency, per-command responsiveness, hot paths) ([pm-3l76](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3l76.toon))

## 2026.7.2 - 2026-07-02

### Changed

- CodeFactor/Complexity: decompose runUpdate, the update mutate apply-callback, and register-mutation MCP arrows ([pm-0n6p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0n6p.toon))

## 2026.7.1 - 2026-07-01

### Changed

- CodeFactor/Complexity: decompose runCreate (CC 172) and the audit-scope update guard (CC 38) ([pm-g7vl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g7vl.toon))

### Fixed

- Auto Release blocked: bot cannot push version commit to protected main (GH006, 12 required checks) ([pm-9gxi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9gxi.toon))

### Removed

- CodeFactor/Complexity: remove 33 suppressions and split 100+ complexity-point dispatch hot spots ([pm-o34s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-o34s.toon))

### Other

- CodeFactor/Complexity: cut cyclomatic-complexity debt across the extension authoring, management & diagnostics surface ([pm-zro7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zro7.toon))
- CodeFactor/Complexity: zero out the SDK contract-resolution, extension-loader and composition surface ([pm-lzzp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lzzp.toon))
- AGENTS.md: mandate reading full live pm item data (status/resolution/comments) before any state claim ([pm-g61e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-g61e.toon))

## 2026.6.30 - 2026-06-30

### Added

- Describe --markdown writes reference docs to a file ([pm-u2tm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u2tm.toon))
- Complete scaffold capability matrix: --capability renderers/parser/preflight/services starters ([pm-i5p5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i5p5.toon))
- Scaffolded & authored command-bearing extensions reliably activate for their own commands ([pm-yxb5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yxb5.toon))
- Project profile presets: compose types, statuses, fields, workflows, templates, and packages ([pm-v37g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v37g.toon))
- pm next: recommend the next actionable (unblocked, ready) work item with rationale + blocked companion ([pm-nj90](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nj90.toon))
- Add pm package / pm packages shell completion (bash/zsh/fish), including the package-only --declarative flag ([pm-mthy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mthy.toon))
- Project profile author-time validation: lintProjectProfile + assertProjectProfile + pm profile lint ([pm-j1fj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j1fj.toon))
- pm package/extension init --capability profile: scaffold a project-profile starter package ([pm-h2hk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-h2hk.toon))
- SDK + CLI: render extension/package surfaces to Markdown reference docs (renderExtensionSurfaceMarkdown + describe --markdown) ([pm-dmum](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dmum.toon))
- pm package/extension init --capability schema: scaffold custom item type/field/migration starter ([pm-d1ig](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-d1ig.toon))
- First-party baseline profile package built on public SDK primitives ([pm-a7o4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-a7o4.toon))
- pm package init --declarative: scaffold a composeExtension blueprint starter + author-time preflight test ([pm-8mxg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8mxg.toon))
- SDK test harness summary/render surface ([pm-2qte](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2qte.toon))
- TypeScript-only extension loading: ship .ts entry, load via Node native type stripping (no compiled .js) ([pm-2p7a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2p7a.toon))
- Extension-contributed project profiles: api.registerProfile end-to-end ([pm-08sv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-08sv.toon))

### Changed

- ADR: pm extensions are authored AND loaded as TypeScript via Node native type stripping ([pm-m1uz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-m1uz.toon))
- CodeFactor/Duplication: remove duplicated code blocks (×20: 2 Critical, 3 Major, 15 Minor) ([pm-fmjy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fmjy.toon))
- CodeFactor/Complexity: reduce cyclomatic complexity (×152: 3 Critical, 7 High, 142 Moderate) ([pm-arzz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-arzz.toon))

### Fixed

- pm validate --check-files mis-handles remote (URL) doc/file references: flagged as deleted and silently destroyed by --prune-missing ([pm-k2n4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-k2n4.toon))
- pm next hides completed-container closeout rows while leaf work exists ([pm-9g87](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9g87.toon))
- MCP action-schema contracts drifted from CLI flag tables (guide.list, health.brief, validate.parentCycleSeverity, contracts.full) ([pm-zx13](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zx13.toon))
- describeExtensionBlueprint omits importer/exporter-with-options command definitions (parity gap vs describeExtensionActivation) ([pm-zqes](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zqes.toon))
- Contracts command lookup should handle package namespace roots ([pm-y1o4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-y1o4.toon))
- GH-363: Windows nightly (Node 24) red — runtime-loader colon-path + telemetry detached-spawn unhandled error + npm-install regression ([pm-xaib](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xaib.toon))
- CI: make Codecov badge uploads branch-explicit ([pm-x878](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x878.toon))
- deriveExtensionCapabilities omits 'schema' for importer/exporter options.flags (declarative blueprint under-grant) ([pm-v3ty](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v3ty.toon))
- pm install does not scaffold extension-contributed item-type folders (transient missing_directory health warning) ([pm-rjab](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rjab.toon))
- Auto Release blocked-alert step can never create its tracking issue (auto-release.yml missing issues:write) ([pm-qawd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qawd.toon))
- pm package doctor should warn when a schema package registers item types/fields but declares narrow activation.commands (silently non-global) ([pm-ok47](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ok47.toon))
- Scaffolded search/importers package commands fail to dispatch: lazy-activation probe skips command-bearing extensions that omit activation.commands ([pm-nacb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nacb.toon))
- CodeFactor/Maintainability: fix unsafe optional chaining (no-unsafe-optional-chaining ×25) ([pm-m8yl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-m8yl.toon))
- Package lifecycle typo recovery should suggest action subcommands ([pm-js02](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-js02.toon))
- Windows background stop progress assertion ([pm-bnh3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bnh3.toon))
- CodeFactor no-regression gate: complexity ceiling + ESLint suppressions baseline + Greptile in local CI/CD ([pm-bkcv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bkcv.toon))
- Aggregate --status all should match duplicate-safe lifecycle filters ([pm-bhtx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bhtx.toon))
- Harden extensionNeedsActivationForProbe: non-terminal search gate + command-bearing importers ([pm-b5r8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b5r8.toon))
- Sentry PM-CLI-1T: pm stats should tolerate disappearing history streams ([pm-7o0s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7o0s.toon))
- pm next should skip completed open containers when recommending actionable work ([pm-2n6i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2n6i.toon))
- GH-348/GH-376: Windows nightly Vitest worker fork exits unexpectedly after passing tests ([pm-2kkl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2kkl.toon))

### Removed

- CodeFactor/Maintainability: remove useless object-spread fallbacks (unicorn/no-useless-fallback-in-spread ×57) ([pm-xsth](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xsth.toon))

### Other

- 2026-06-25 PM ecosystem taxonomy and context backlog normalization ([pm-57vh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-57vh.toon))
- Normalize stale audit containers and intentional-open resolved items ([pm-psc0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-psc0.toon))
- Extend pm package init --declarative to the full capability matrix (hooks/search/importers/schema/renderers/parser/preflight/services) ([pm-lfdv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lfdv.toon))
- CodeFactor parity tooling: local ESLint (unicorn) + complexity + duplication lint to reproduce findings and prevent regressions ([pm-6sqo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6sqo.toon))
- Built-in MCP actions are now extension-aware: pm_profile/pm_list/pm_schema activate workspace extensions like the CLI ([pm-zumn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zumn.toon))
- Sub-agent lane: source, tests, docs, and command-surface coverage map ([pm-xezi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xezi.toon))
- Schema scaffold tests: unit coverage (package+extension variants) + materialize/run generated node:test smoke ([pm-x3vi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x3vi.toon))
- pm profile list/show/apply merges extension-registered profiles with source labels ([pm-vpwt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vpwt.toon))
- Package scaffolds declare current SDK compatibility floor ([pm-sf08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sf08.toon))
- Document activation.commands lazy-activation contract in scaffold README, EXTENSIONS.md, SDK.md ([pm-scvz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-scvz.toon))
- Refresh runtime dependencies for audit baseline ([pm-r642](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r642.toon))
- ADR: profile lint severity model — errors break apply, warnings flag suspicious-but-valid cross-references ([pm-qcdu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-qcdu.toon))
- CodeFactor/Maintainability: clear remaining unicorn lints (no-thenable ×4, no-useless-spread ×2, no-useless-length-check ×1) ([pm-q0ye](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q0ye.toon))
- Schema scaffold docs: EXTENSIONS.md, SDK.md, shell completion, help-content examples ([pm-pwf1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pwf1.toon))
- Docs: SDK.md/EXTENSIONS.md document api.registerProfile + regenerate contracts/full.json ([pm-ol8j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ol8j.toon))
- Sub-agent lane: SDK, packages, MCP, and universal customization backlog ([pm-o578](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-o578.toon))
- Scaffold emits manifest activation.commands matching registered command paths per capability ([pm-mhih](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mhih.toon))
- Implement schema scaffold capability in scaffold.ts (manifest/entrypoint/README/define\* guidance, omit activation.commands) ([pm-mdw6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mdw6.toon))
- SDK profile parity: assertRegisteredProfile + composeExtension blueprint.profiles + deriveExtensionCapabilities + describe ([pm-l8fl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l8fl.toon))
- Sub-agent lane: tracker taxonomy, hierarchy, and duplicate hygiene ([pm-klpw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-klpw.toon))
- Dogfood: pm-kanban registers kanbanProfile so pm profile apply kanban works ([pm-kj7x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kj7x.toon))
- Schema-capability scaffolds must omit narrow activation.commands so custom item types/fields register globally ([pm-halx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-halx.toon))
- Action-scoped MCP parameter descriptions: split shared name/target description per action (schema vs profile) ([pm-fq80](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fq80.toon))
- ADR: offline BM25 lexical provider + relevance eval harness for search quality ([pm-f2al](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-f2al.toon))
- ADR: explicit pm_format_version front-matter field for storage schema evolution ([pm-eeai](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-eeai.toon))
- PR \#406 review follow-up: clear partial MCP extension registries before fallback execution ([pm-dyzy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dyzy.toon))
- Expose project profile application through MCP contracts and drift gates ([pm-bhmk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bhmk.toon))
- ADR: dependency-aware actionability for pm next — ready = active leaf with no open blocked_by; reuse compareCriticalItems + shared blocked_by resolver ([pm-9x6k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-9x6k.toon))
- registerProfile core registration surface: ExtensionApi + registry + loader gate + capability-usage + policy surface ([pm-6oox](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6oox.toon))
- First-party package manifests declare current SDK compatibility floor ([pm-6d7q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6d7q.toon))
- Refresh Sentry release and telemetry dependencies ([pm-4dz7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-4dz7.toon))
- Decompose cli-contracts.ts monolith into flag-contracts + tool-schema sibling modules ([pm-3wue](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3wue.toon))
- Sub-agent lane: release, GitHub, Sentry, telemetry, and live-ops evidence ([pm-3whx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3whx.toon))

## 2026.6.24 - 2026-06-24

### Added

- SDK author-once manifest synthesis: synthesizeExtensionManifest + assertExtensionManifestMatchesBlueprint ([pm-u5le](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u5le.toon))
- SDK unified author-time preflight capstone: preflightExtension + assertExtensionPreflight ([pm-ozaf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ozaf.toon))
- Modular declarative authoring: mergeExtensionBlueprints + composeExtensionPackage ([pm-2p38](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2p38.toon))
- SDK author-time version-compatibility preflight: checkExtensionManifestCompatibility + assertExtensionManifestCompatible ([pm-1w0d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1w0d.toon))
- TypeScript-first extension & package scaffolding + SDK docs reframe ([pm-09rh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-09rh.toon))

### Changed

- Extract shared version-compat core (core/extensions/version-compat.ts); loader delegates, behavior-preserving ([pm-sjea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sjea.toon))

### Other

- preflightExtension(blueprint, options) — pure unified author-time analyzer (compose.ts) ([pm-tcw1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tcw1.toon))
- assertExtensionPreflight(blueprint, options) — throwing CI/test bookend (testing.ts) + barrel re-export ([pm-t8yl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t8yl.toon))
- assertExtensionManifestMatchesBlueprint(manifest, blueprint): strict least-privilege CI guard against capability drift ([pm-pfxi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pfxi.toon))
- defineExtensionBlueprint: typed identity helper for partial blueprint fragments ([pm-nvgy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nvgy.toon))
- synthesizeExtensionManifest(blueprint, identity): generate a complete least-privilege ExtensionManifest from a blueprint ([pm-nr5j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nr5j.toon))
- Reframe SDK docs & docstrings TypeScript-first (SDK.md, EXTENSIONS.md, define\*/compose\*) ([pm-l2ud](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l2ud.toon))
- checkExtensionManifestCompatibility(manifest, target) — pure author-time analyzer ([pm-knma](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-knma.toon))
- assertExtensionManifestCompatible(manifest, target) — SDK testing assert ([pm-hng2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hng2.toon))
- mergeExtensionBlueprints: pure modular composition of partial ExtensionBlueprints ([pm-high](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-high.toon))
- Scaffolder emits TypeScript source: index.ts + tsconfig.json + type-check/test scripts (./index.ts entry) ([pm-frou](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-frou.toon))
- composeExtensionPackage: author-once capstone returning { module, manifest } ([pm-cn0c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cn0c.toon))
- Convert docs/examples extensions to TypeScript-first (starter-extension, policy-restricted-extension) ([pm-ax7z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ax7z.toon))
- ADR: pm extensions & SDK packages must be authored fully in TypeScript ([pm-2c28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-2c28.toon))

## 2026.6.23 - 2026-06-23

### Added

- SDK describeExtensionBlueprint: static author-time surface map of a composeExtension blueprint (author-time inverse of describeExtensionActivation) ([pm-tlpv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tlpv.toon))
- pm extension/package describe: agent-facing CLI + MCP surface for describeExtensionActivation ([pm-l4c8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-l4c8.toon))
- Unified extension test harness (createExtensionTestHarness): one fluent fixture binding all activate/assert/invoke/deactivate SDK helpers ([pm-jcyn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jcyn.toon))
- Declarative extension authoring: composeExtension blueprint + deriveExtensionCapabilities + defineExtensionManifest ([pm-iqq0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-iqq0.toon))
- SDK lintExtensionBlueprint + assertExtensionBlueprint: author-time preflight for composeExtension blueprints (capability drift, duplicate commands, empty surfaces) ([pm-9ect](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9ect.toon))
- SDK describeExtensionActivation: single-call introspection of every registered surface (complements assert\*/run\*) ([pm-16ue](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-16ue.toon))
- SDK authoring-time define\* typed builders for every extension registration surface ([pm-12tj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-12tj.toon))

### Fixed

- deriveExtensionCapabilities omits 'schema' for a CommandDefinition with inline flags (manifest under-grant would fail activation) ([pm-5758](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5758.toon))
- GH-340: Windows nightly telemetry OTLP cleanup EBUSY ([pm-zpe7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zpe7.toon))

### Other

- ADR: SDK author-time helpers are the static inverse of runtime extension checks (derive↔reconcile, describe-blueprint↔describe-activation, lint↔loader-enforcement+doctor) ([pm-4oio](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-4oio.toon))
- ADR: SDK define\* builders are zero-cost identity helpers (defineConfig pattern), generic for object defs / non-generic for function defs ([pm-3mph](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-3mph.toon))

## 2026.6.22 - 2026-06-22

### Added

- pm package init --capability search: scaffold search provider starter packages ([pm-pwai](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pwai.toon))
- SDK testing helper to invoke a registered extension command handler: runRegisteredCommandForTest ([pm-owm0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-owm0.toon))
- pm package init --capability <kind\>: scaffold capability-targeted starter packages (commands\|hook) ([pm-nhby](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nhby.toon))
- Complete the SDK extension-invoke testing surface: runRegisteredHookForTest + override invoke helpers ([pm-miqm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-miqm.toon))
- Add importers package scaffold and dependency-maintenance closeout ([pm-j5az](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j5az.toon))
- Least-privilege capability reconciliation: pm package doctor flags declared-but-unused extension capabilities + SDK assertExtensionCapabilityUsage ([pm-fk84](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-fk84.toon))
- SDK invoke helpers for search providers, vector store adapters and migrations ([pm-bd3u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bd3u.toon))
- SDK invoke helpers for importers & exporters: runRegisteredImporterForTest + runRegisteredExporterForTest ([pm-1p2u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1p2u.toon))
- SDK deactivate test lifecycle: deactivateExtensionForTest + assertExtensionDeactivated helpers ([pm-0zn9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0zn9.toon))

### Fixed

- Fix Windows nightly full-test path and permission assumptions ([pm-83rt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-83rt.toon))

### Other

- Package and extension scaffolds emit least-privilege manifest policy metadata ([pm-bav0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bav0.toon))

## 2026.6.21 - 2026-06-21

### Added

- item-format-migration: add format-version field to front-matter for future migration gating ([pm-ae1u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ae1u.toon))
- Complete SDK package-author test-assertion surface: service-override + migration helpers ([pm-6pmp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6pmp.toon))

### Fixed

- Windows nightly: secondary POSIX-separator + mocked-path test class (static-quality-gate, docs-skills-gate, bundle-cli, contracts-snapshot, smoke-npx-from-pack) ([pm-s5pe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s5pe.toon))
- Nightly windows-latest STILL red after pm-i84i: scriptModule test harness imports .mjs scripts via absolute file:// URL, shebang survives missing transform (SyntaxError) ([pm-dita](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dita.toon))

### Other

- Code quality & perf audit 2026-06-12 ([pm-nimu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nimu.toon))
- SDK testing helper for registerFlags registrations ([pm-oveq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oveq.toon))

## 2026.6.20 - 2026-06-20

### Added

- Add wiring-checklist reference card to ARCHITECTURE.md for new command authors ([pm-zyse](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zyse.toon))
- Add 120-file unit-test cap governance test to ci-workflow-contract.spec.ts ([pm-wc0d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wc0d.toon))
- Search relevance eval harness: implement nDCG/MRR runner and gate in CI ([pm-u8n5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u8n5.toon))
- gc --scope checkpoints: prune stale bulk-mutation checkpoint files ([pm-tyj8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tyj8.toon))
- Add Windows path-separator test coverage for fs-utils and store/paths ([pm-tq5t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tq5t.toon))
- Add remediation registry entry for validate_metadata_duplicate_issue_codes warning ([pm-sdbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-sdbo.toon))
- Add performance / startup-latency section to ARCHITECTURE.md ([pm-p37b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p37b.toon))
- Add vitest.config.ts coverage include/exclude governance guidance to ARCHITECTURE.md ([pm-othr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-othr.toon))
- Sentry KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS maintenance: add a governance test to prevent silent accumulation of stale patterns ([pm-jxls](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jxls.toon))
- Add nightly.yml failure alerting: notify on Windows/Node25 smoke failures ([pm-ehbb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ehbb.toon))
- Add remediation registry entry for extension_update_health_partial_coverage warning ([pm-bdvm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bdvm.toon))
- Add integration test for close-many --rollback checkpoint restore ([pm-7p4w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7p4w.toon))
- Offline BM25 lexical retrieval provider when no Ollama/OpenAI is configured ([pm-75k9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-75k9.toon))
- Add integration test for background-refresh (instant mutations) non-blocking behavior ([pm-5rge](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5rge.toon))
- Add integration test for schema add-type / remove-type round-trip with governance.workflow_enforcement ([pm-4dtf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-4dtf.toon))
- LanceDB snapshot: add gc --scope embeddings to include pending-refresh.json and drift-cache coordination ([pm-3b1t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3b1t.toon))

### Changed

- COMMANDS.md omits pm get and pm copy; command-families table missing get/copy/update-many/close-many ([pm-xvzm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xvzm.toon))
- Replace 'as unknown as ItemMetadata' double-casts (9 sites) with typed mutation/replay returns ([pm-ul02](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ul02.toon))
- Refactor runUpdate (~950-line function) into table-driven per-field apply helpers ([pm-e7dn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-e7dn.toon))

### Fixed

- GH-293..296 CLI parser and search regression bundle ([pm-yy45](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yy45.toon))
- appendLineAtomic is not truly atomic: concurrent appends to history JSONL can interleave ([pm-xy9n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xy9n.toon))
- Project-scope extension install writes ~69MB node_modules per workspace (peer pm-cli + transitive Sentry/OTel) ([pm-oxq2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oxq2.toon))
- Daily auto-release was silently blocked 06-14..16 by a single stale, unresolved Sentry error (sentry-telemetry-gate is:unresolved has no time window) ([pm-nb08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nb08.toon))
- Fix ARCHITECTURE.md storage layout: add plans/, stories/, schema/, checkpoints/, runtime/ dirs ([pm-mcgf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mcgf.toon))
- Nightly windows-latest red since 2026-06-14: ~373 tests fail with 'SyntaxError: Invalid or unexpected token' from file://-URL TS dynamic imports + POSIX-separator assertions ([pm-i84i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i84i.toon))
- Accept --status all for duplicate-safe search and list filters ([pm-i02t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i02t.toon))
- Fix nightly cross-platform reliability: macOS realpath in extension-command test and Windows .cmd spawn EINVAL ([pm-gf6f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gf6f.toon))
- pm health 2.3-3.1s in dev repo (~2x the 1.3s baseline): drift-scan cache hit still reads + content-hashes every history stream ([pm-c90s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c90s.toon))
- pm-changelog over-escapes markdown in entry titles (parens + intra-word underscores) ([pm-3299](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3299.toon))

### Removed

- Built-in type lists and storage layout drift: Plan missing; ARCHITECTURE.md still lists removed index/ dir ([pm-7u4z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7u4z.toon))

### Other

- Export hygiene: 1 dead export + ~57 exported-but-internal-only symbols ([pm-vn9l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vn9l.toon))
- Unknown-command did-you-mean misses executable aliases: 'pm shwo' gets no suggestion (show/view/comment not in candidate set) ([pm-i35t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i35t.toon))
- Sentry tracesSampleRate is hardcoded at 0.2 — expose as configurable knob or document intent ([pm-gg8e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gg8e.toon))
- Document search eval golden-query harness usage in TESTING.md ([pm-eg9k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eg9k.toon))
- CLAUDE_CODE_PLUGIN.md drift: architecture tree shows 9/14 commands + 1/4 agents; compat table says plugin 1.0.0 (actual 1.4.0) ([pm-cxi9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cxi9.toon))
- Docs index missing EXTENSION_AUTHOR_CONTRACTS + MIGRATION_CLI_SIMPLIFICATION links; migration note predates --pm-path ([pm-c97q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-c97q.toon))
- pm todos import: positional source arg silently ignored + folder-not-found error omits --folder flag (beads parity) ([pm-90hp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-90hp.toon))

## 2026.6.19 - 2026-06-19

### Added

- Add agent-identity dimension to telemetry events: surface PM_AUTHOR as hashed author_context ([pm-fbyu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-fbyu.toon))
- Sub-hour duration granularity for scheduling: support minutes in --duration / event duration= ([pm-zoe4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zoe4.toon))
- pm context --fields: per-row field projection for focus items (GH-156 follow-up to --depth full) ([pm-hnjf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hnjf.toon))
- pm history-compact: expose --scope all-streams (history GC pass) for closed items ([pm-yj9w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yj9w.toon))
- Core read/validate integrity: exact-ID search rank guarantee across modes + parent-hierarchy cycle detection ([pm-rkie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rkie.toon))
- pm search: structured inline query syntax (tag:/status:) + matched-text highlighting (GH-157 remainder) ([pm-ldr1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ldr1.toon))
- Dedupe merge workflow: pm dedupe-merge to consolidate duplicates (GH-163, builds on closed pm-4n1a detection) ([pm-jmld](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jmld.toon))
- pm telemetry stats: add error_rate and resolution breakdown per command bucket ([pm-gsoe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gsoe.toon))
- History stream bulk-compaction: pm history-compact --all-over N to batch-compact large streams ([pm-f3pa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f3pa.toon))
- pm plan discoverability: templates and auto-suggest for complex work (GH-158 remainder) ([pm-aer3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-aer3.toon))
- Validate governance accuracy: suppress false-positive duplicate-code & terminal-item metadata noise + files --remove input clarity ([pm-6bz1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6bz1.toon))
- GH-208: linked test sandbox ergonomics ([pm-52eh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-52eh.toon))
- Surface duration_ms percentile breakdown in pm telemetry stats (p50/p95 per command) ([pm-3n3b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3n3b.toon))
- pm list output formats: csv/table for human export (GH-154 remainder) ([pm-1lll](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1lll.toon))
- Auto-compact policy: config-driven threshold to trigger pm history-compact automatically ([pm-0pnz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0pnz.toon))

### Changed

- pm update --allow-audit-update: permit append-only --comment/--file/--doc evidence (GH-207) ([pm-kanu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kanu.toon))

### Fixed

- pm templates: unknown subcommand + flags silently fall back to 'list' (exit 0) instead of erroring ([pm-r2kd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r2kd.toon))
- linked-test-adapters package install loses ESM module type ([pm-v8fy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v8fy.toon))
- GH-215: enforce timestamps in history entries ([pm-u42x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u42x.toon))
- GH-281: exact-ID search match is rank-diluted in hybrid/semantic mode (keyword score normalized + capped by keyword weight) ([pm-oqgf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oqgf.toon))
- Dynamic package commands should reject excess args and unknown parent tokens ([pm-nt1y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nt1y.toon))
- GH-206: test-all silent run process-liveness regression ([pm-mcxr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mcxr.toon))
- GH-262: prevent path-like pm init from corrupting caller tracker settings ([pm-jek2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jek2.toon))
- GH-284: align pm init required schema directories with health ([pm-hl9y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hl9y.toon))
- CI contracts snapshot temp cleanup can fail with ENOTEMPTY ([pm-c61g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c61g.toon))
- PR \#266 review feedback: tighten init and dynamic option validation ([pm-at1j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-at1j.toon))
- GH-265: schema unknown subcommands must not create custom types ([pm-ablm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ablm.toon))
- GH-280: pm validate does not detect circular parent references (hierarchy cycles A-\>B-\>A of any length) ([pm-8vul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8vul.toon))
- Auto Release retries branch push after main advances ([pm-5oti](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5oti.toon))

### Other

- Dogfood audit 2026-06-12: ecosystem verification (CLI+SDK+packages) ([pm-krgd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-krgd.toon))
- PR \#274 review follow-up: CodeQL and bot feedback ([pm-0bwe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0bwe.toon))
- GH \#268-\#270 agent lookup and context output polish ([pm-x7g1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x7g1.toon))
- SDK.md PM_PACKAGE_RESOURCE_KINDS drift: assets/prompts kinds missing ([pm-u8y9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-u8y9.toon))
- GH-276: metadata check skip terminal items for planning fields ([pm-pktw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pktw.toon))
- Repo-wide docstring coverage gate for source files ([pm-p4mw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p4mw.toon))
- GH-277: files --remove path-only input clarity ([pm-k8ld](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k8ld.toon))
- GH \#267/\#271/\#272 follow-up: lifecycle automation, logical dependency validation, read format parity ([pm-8uhf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8uhf.toon))
- PR \#274 second review follow-up: prefix, format, and owner scoring ([pm-89ur](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-89ur.toon))
- GH-278: duplicate_issue_codes exclude items closed-as-duplicate ([pm-5fid](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5fid.toon))
- GH-275: duplicate_issue_codes skip legitimate parent/child code-prefix pairs ([pm-2nxe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2nxe.toon))

## 2026.6.17 - 2026-06-17

### Added

- GH-216: default lifecycle transition suggestions ([pm-y1z0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-y1z0.toon))
- pm schema list-fields / show-field / add-field / remove-field: CLI management of schema/fields.json ([pm-vhbf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vhbf.toon))
- GH-245: schema add-type --infer from title prefixes ([pm-tb42](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tb42.toon))
- Expose schema.unknown_field_policy via pm config set schema_unknown_field_policy ([pm-nnaq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nnaq.toon))
- Expose id_prefix, author_default, output.default_format, locks.ttl_seconds via pm config set ([pm-9byd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9byd.toon))
- pm schema apply-preset <agile\|ops\|research\>: standalone type-preset for already-initialized projects ([pm-86ob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-86ob.toon))
- GH-217: scheduling type creation shortcuts ([pm-76r5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-76r5.toon))
- GH-258: strict unknown-key rejection across all structured CSV/markdown link & metadata parsers (validation parity with test --add) ([pm-0v9k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0v9k.toon))

### Fixed

- Sentry PM-CLI-1R: 'cannot add command init as already have command init' — top-level init double-registration throws raw Commander error ([pm-zyez](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zyez.toon))

### Other

- Document schema/fields.json runtime custom field authoring in CONFIGURATION.md ([pm-izx5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-izx5.toon))

## 2026.6.16 - 2026-06-16

### Added

- pm search keyword mode: --match-mode (and/or/exact) + default result limit (GH-181 remainder) ([pm-i1z6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i1z6.toon))
- Metadata governance & coverage observability (missing-field filters, stats breakdowns, validate full-id lists, aggregate explicit labels) ([pm-yq7m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yq7m.toon))
- GH-235: detect duplicate logical issue code prefixes ([pm-rpag](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rpag.toon))
- GH-236: governance metadata missing-field filters ([pm-mfl1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-mfl1.toon))
- Module-mirrored test reorganization: retire lane/wave naming, add shared script harness ([pm-m449](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m449.toon))
- Search corpus: include type, priority, parent, assignee fields in keyword and semantic corpus ([pm-jyie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jyie.toon))
- pm context --depth full: comprehensive snapshot (all sections, no per-section cap) (GH-156) ([pm-j0vc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j0vc.toon))
- pm close: short aliases -m/-r/-d for --message/--reason/--duplicate-of (GH-226) ([pm-i1mu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i1mu.toon))
- GH-242: field-existence filters for list/search ([pm-hntj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hntj.toon))
- GH-244: surface provider/vector-store resolution source in pm health ([pm-gnu2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gnu2.toon))
- pm validate: missing-link owner attribution (GH-210) + type-default estimate backfill (GH-212) ([pm-gnnb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gnnb.toon))
- pm get: include child rollup summary for Milestone/Epic items (GH-155) ([pm-gcm3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gcm3.toon))
- pm context --parent <id\>: scope snapshot to a single epic/parent subtree ([pm-ds0m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ds0m.toon))
- Configurable min-score threshold for pm search: --min-score per-query override of search.score_threshold ([pm-cstl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cstl.toon))
- Apply Gemini correctness fixes & cover new branches (config/init/reindex/register-mutation) ([pm-bw70](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bw70.toon))
- GH-241: stats content-field utilization metrics ([pm-7snq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7snq.toon))
- pm create/update --body-file: load body markdown from a file (GH-214) ([pm-7c48](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7c48.toon))
- pm focus: session default parent/context inheritance for new items (GH-161) ([pm-72xf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-72xf.toon))
- GH-243: comments edit/delete lifecycle commands ([pm-4swf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4swf.toon))
- Search: persistent search.hybrid_semantic_weight setting as default for pm search --semantic-weight ([pm-2xwh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2xwh.toon))
- pm search filter parity with pm list: add --updated-after/before, --created-after/before, --assignee, --sprint, --release, --parent ([pm-13nx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-13nx.toon))
- Finalize literal 100% coverage: close c8-ignore-masked gaps & remediate PR \#240 bot review ([pm-0xix](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0xix.toon))
- pm list --no-truncate/--all: explicit override of any --limit + surface total vs returned count (GH-154) ([pm-0c0j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0c0j.toon))

### Changed

- Dedupe history-rewrite orchestration block triplicated across history-redact/repair/compact ([pm-bzgt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bzgt.toon))
- Small verified cross-file duplications (4 pairs) + static-gate duplicate scan does not cover src/cli ([pm-z2gi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-z2gi.toon))
- pm update-many: --filter-ac-missing/--filter-estimates-missing/--filter-resolution-missing selection filters for bulk backfill (GH-220) ([pm-wbak](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wbak.toon))
- LOC growth watch: 5 src files back over 2000 lines (cap 3400) after 2026-05-25 barrel splits ([pm-k1im](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k1im.toon))
- health.ts re-implements doctor.ts capability-guidance helpers verbatim instead of importing the exported versions ([pm-aabt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-aabt.toon))

### Fixed

- Extension activation failure is invisible outside pm health --json: extension list shows ok, no stderr hint, commands partially registered ([pm-yffj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yffj.toon))
- pm create <type\> --title X silently ignores positional type, defaults to Task ([pm-8sr3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8sr3.toon))
- GH-209 follow-up: OTEL span export keeps the CLI alive ~10s (and can exit 13) when the traces endpoint is unreachable ([pm-25se](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-25se.toon))
- GH-256: update-many --dry-run skips field validation (priority/type/status/deadline) ([pm-v4tb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v4tb.toon))
- GH-253: invalid --type create error hardcodes .agents/pm path, ignoring active --pm-path ([pm-nd08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nd08.toon))
- GH-205: surface telemetry flush/probe + OTEL export diagnostics in pm health ([pm-hx5a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hx5a.toon))
- GH-252: pm get --json places body outside item (parity with list --include-body) ([pm-hofv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hofv.toon))
- c8 ignore end (invalid keyword) silently masked source coverage; literal-100% gate passed on hidden code ([pm-dg8j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dg8j.toon))
- GH-249: create --status closed bypasses governance.require_close_reason ([pm-4a1p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4a1p.toon))
- GH-248: fix schema add-type silent slug-collision overwrite + malformed-name acceptance ([pm-3l0f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3l0f.toon))
- GH-250: pm close checks item existence before the close-reason gate ([pm-1jtl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1jtl.toon))

### Security

- Track open Dependabot alerts \#39/\#40/\#41 (vite and @opentelemetry/core) ([pm-c24n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c24n.toon))

### Other

- Content-field & governance introspection (GH-241/242/236) ([pm-php4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-php4.toon))
- Source-correctness audit of all-source-100%-coverage branch src/ edits ([pm-e2jt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-e2jt.toon))
- Test-suite dedup & best-practice audit (post module-mirror reorg) ([pm-2nqx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2nqx.toon))
- GitHub issue triage 2026-06-12 ([pm-tk1z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tk1z.toon))
- pm close: when require_close_reason is on, accept --resolution text as the close reason instead of hard-blocking ([pm-7x8d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7x8d.toon))
- Literal 100% all-source test coverage & module-mirrored test reorganization ([pm-xau3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-xau3.toon))
- ADR: literal all-src coverage supersedes curated include/exclude allowlist ([pm-w13j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-w13j.toon))
- pm aggregate: explicit (unassigned)/(none) labels for blank group keys in all output modes (GH-225) ([pm-zcx9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zcx9.toon))
- tests/unit is at exactly 120/120 spec files: zero headroom before Gates(static) fails; consolidation candidates identified ([pm-vks9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-vks9.toon))
- Coverage to 100%: src/cli infrastructure (registration, bootstrap, help, main) ([pm-uvxc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uvxc.toon))
- Coverage to 100%: src/cli command handlers (group A — mutation, history, storage, schema) ([pm-ud1x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ud1x.toon))
- Document and test telemetry env-var surface: PM_TELEMETRY_DISABLED, PM_NO_TELEMETRY, PM_TELEMETRY_SOURCE_CONTEXT, PM_TELEMETRY_OTEL_DISABLED, PM_TELEMETRY_INLINE_FLUSH ([pm-r7md](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r7md.toon))
- Slim guided-error boilerplate in agent contexts; lead unknown-command Examples with the did-you-mean candidate ([pm-q0kr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q0kr.toon))
- pm validate: --all-affected-ids flag + never truncate ID lists in JSON mode (GH-224) ([pm-o0d2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-o0d2.toon))
- PR \#240 review: applied vs declined Gemini findings (with rationale) ([pm-lg65](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-lg65.toon))
- ADR: test organization convention — module-mirrored spec files, no lane/wave naming ([pm-kjmx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-kjmx.toon))
- Shared core/governance/metadata-coverage primitive: missing-field predicates + coverage % + grouped lifecycle counts ([pm-hm1q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hm1q.toon))
- pm stats: --by-assignee/--by-tag/--by-priority breakdowns + --metadata-coverage + lifecycle/type adoption (GH-213/218/219) ([pm-gq27](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gq27.toon))
- pm list: --filter-ac-missing/--filter-estimates-missing/--filter-resolution-missing/--filter-metadata-missing (GH-228) ([pm-fryg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fryg.toon))
- Coverage to 100%: build, release, and smoke scripts ([pm-f2ne](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-f2ne.toon))
- Close c8-exposed coverage gaps in src/cli/commands/create.ts to 100% ([pm-eifq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eifq.toon))
- Close c8-exposed coverage gaps in src/cli/commands/contracts.ts and restore.ts to 100% ([pm-dmuq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dmuq.toon))
- Close c8-exposed coverage gaps in src/cli/commands/history-redact.ts and normalize.ts to 100% ([pm-byl1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-byl1.toon))
- Coverage to 100%: src/cli command handlers (group B — query, search, calendar, test, init, extension) ([pm-7v9s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7v9s.toon))
- Coverage to 100%: packages, plugins, and docs examples ([pm-6tch](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6tch.toon))

## 2026.6.13 - 2026-06-13

### Changed

- Dedup private Levenshtein implementations onto shared OSA helper ([pm-dzcx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dzcx.toon))

### Fixed

- pm-mcp bin is dead on npm installs: main-module guard fails under symlinked argv\[1\] (silent exit 0, no JSON-RPC output) ([pm-qtbc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qtbc.toon))
- pm validate --check-files misclassifies existing directories as deleted (GH-203, prune/auto-fix data-loss path) ([pm-b1ni](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b1ni.toon))
- Compact strict-create recovery duplicates missing fields under two keys ([pm-3rjo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3rjo.toon))
- Claude Code plugin install spec drift: README says pm-cli@pm but plugin name is pm-claude ([pm-m4bx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m4bx.toon))
- GH-209: successful pm mutations can exit 13 from unsettled top-level await ([pm-1byt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1byt.toon))

### Other

- Ecosystem audit + GH-204..208/210 remediation session 2026-06-13 ([pm-y7sc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-y7sc.toon))
- Compact strict create recovery for agents ([pm-tjvl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tjvl.toon))
- CI gap: plugin/package markdown pushed to main runs no functional workflow ([pm-5909](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5909.toon))

## 2026.6.12 - 2026-06-12

### Added

- Add pm health 'locks' check: surface stale item-claim counts before gc is needed ([pm-xo1n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xo1n.toon))
- pm validate metadata report grouped by item type (GH-172) ([pm-pmyq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pmyq.toon))
- pm files/docs: standalone --note flag alongside --add (GH-170) ([pm-pfnx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pfnx.toon))
- pm validate --auto-fix: apply safe remediations automatically (GH-179, GH-153 interactive part, GH-167 backfill part) ([pm-c3sz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-c3sz.toon))
- pm history-repair --all: bulk drift repair across streams (GH-171) ([pm-9ftr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9ftr.toon))
- pm validate --check-files: classify stale linked paths (moved vs deleted) and offer --prune-missing (GH-184) ([pm-0v2m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0v2m.toon))

### Fixed

- Session 2026-06-11: validation auto-fix & self-repair PR (validate --auto-fix/--prune-missing/grouped metadata, history-repair --all, health locks, files/docs --note, plan --step accumulate, consent CI guard, completion drift) ([pm-dhrp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-dhrp.toon))
- Lifecycle subcommand flags duplicated on the parent extension/package command are silently dropped (commander hoists them) ([pm-df9k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-df9k.toon))
- Telemetry first-run prompt CI guard is inverted: CI=true does not skip, only CI=false/0/no/off does ([pm-0hx2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0hx2.toon))
- MCP pm_files discover/apply/discoveryNote params are declared but ignored by the files action handler ([pm-wcaa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wcaa.toon))
- pm validate lifecycle: auto-fix for active items with closed/terminal parents (GH-168) ([pm-8jss](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8jss.toon))
- pm plan create: repeated --step silently keeps only the last value instead of accumulating steps ([pm-6mit](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6mit.toon))
- PR \#200 review: batch validate prune-missing auto-fix removals ([pm-60p0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-60p0.toon))

### Other

- Refresh Sentry expected handled CLI classifier for 2026-06-11 dogfood CommandErrors ([pm-lg9i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lg9i.toon))
- PR \#200 review: contract and defensive hardening follow-up ([pm-im0s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-im0s.toon))
- Shell completion drift: show-status missing from bash/zsh/fish schema subcommand lists ([pm-6qi8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6qi8.toon))
- Milestone calendar_item_without_schedule warning should include actionable hint (GH-174) ([pm-2cgu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2cgu.toon))

## 2026.6.11 - 2026-06-11

### Added

- Add pm_schema and pm_config narrow MCP tools for workspace configuration via MCP ([pm-v68d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v68d.toon))
- MCP pm_list/pm_search: expose active filter summary in compact output so agents know what was applied ([pm-rmjy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rmjy.toon))
- Add narrow pm_append MCP tool for agent log-seeding without pm_run passthrough ([pm-7u9j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7u9j.toon))

### Fixed

- GH-191: test --add command parser should accept quoted commands containing -- ([pm-vcr2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vcr2.toon))

### Other

- Contract schema golden-file must cover MCP tool inputSchema shapes — current snapshot only covers CLI flags ([pm-4os2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-4os2.toon))

## 2026.6.10 - 2026-06-10

### Added

- Combined PR: duplicate-aware close, parent fail-fast, id-only output, context/aggregate completion stats, robust test add/run ([pm-z9e9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-z9e9.toon))
- pm close --duplicate-of: structured duplicate tracking with auto-populated closure fields (GH-183, GH-160) ([pm-xnkd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xnkd.toon))
- Embedding provider migration guide + pm reindex --migrate: automated full reindex on model/provider change ([pm-wt0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-wt0g.toon))
- pm test --run selectors: --match / --only-index / --only-last (GH-194) ([pm-p86h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-p86h.toon))
- pm context: per-epic completion stats + recently_created/unparented sections (GH-187, GH-182) ([pm-ojpq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ojpq.toon))
- Incremental reindex --mode semantic --stale-only: skip already-up-to-date vectors ([pm-o3nr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-o3nr.toon))
- pm_max_version default-BLOCK should have a per-layer warn-only toggle in settings ([pm-k5e8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-k5e8.toon))
- Root --id-only flag: minimal mutation output (id+status) for agent automation loops (GH-195) ([pm-esf6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-esf6.toon))
- pm aggregate --completion: closed/total ratio and completion_pct per group (GH-185) ([pm-eaer](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-eaer.toon))
- Extension teardown: per-deactivate timeout guard so a hanging deactivate() cannot block host shutdown/reload ([pm-bujg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bujg.toon))
- Add importer/exporter options arg and command-def examples to SDK.md ([pm-btwe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-btwe.toon))
- pm list: include parent in default compact projection when set (GH-180) ([pm-awfr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-awfr.toon))
- Add MCP pm_context, pm_contracts, pm_plan, pm_health integration tests ([pm-8d00](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8d00.toon))
- Settings read cache: memoize readSettingsWithMetadata across the 3-5 reads per command ([pm-2bn5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2bn5.toon))
- First-party exemplar package for registerCommand + registerFlags + registerParser (commands capability pattern) ([pm-1js9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1js9.toon))

### Fixed

- Fix Windows Nightly smoke cleanup helper import ([pm-uzty](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-uzty.toon))
- GH-190: SDK locateItem should default idPrefix or throw explicit argument errors ([pm-rjh9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rjh9.toon))
- GH-189: create --parent should fail fast on unresolved references ([pm-p9hw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p9hw.toon))
- Harden history replay and compact diff against malformed patch entries ([pm-kf5q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kf5q.toon))
- Telemetry queue max_attempts backlog health warning: surface items near retry exhaustion in pm health ([pm-irc7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-irc7.toon))
- MCP server: request-scoped extension registries (process-global set/clear can race under concurrent native-action requests) ([pm-bl6m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bl6m.toon))

### Security

- Extension sandbox profiles are advisory-only — no runtime enforcement of declared permission boundaries ([pm-pl53](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pl53.toon))
- Declare trusted=true, sandbox_profile, and permissions on all 9 first-party package manifests ([pm-iljy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-iljy.toon))

### Other

- Document pm-linked-test-adapters package in EXTENSIONS.md and TESTING.md ([pm-yj8n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-yj8n.toon))
- Close stale GH issues, clarify dedupe-audit docs, and bump @sentry/node ([pm-utd6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-utd6.toon))
- Run verification matrix and temp-dir smoke for active cycle ([pm-rav7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rav7.toon))
- SDK author-ergonomics batch: extension-manifest JSON Schema, getWorkspaceContracts memoization, FlagDefinition type/value_type unification ([pm-l0jd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-l0jd.toon))
- Upgrade pm-changelog to 2026.6.9 and validate changelog fidelity ([pm-kx7v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kx7v.toon))

## 2026.6.9 - 2026-06-09

### Added

- PmPackageResourceKind is missing 'assets' and 'prompts' as canonical resource types ([pm-z9ho](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-z9ho.toon))
- Extension API missing self-identity accessor: extensions cannot read their own name, layer, or version at activation ([pm-qo36](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qo36.toon))
- registerItemFields/registerItemTypes: validate declared field type against known coercion kinds with did-you-mean ([pm-oll8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oll8.toon))
- Extension activation: no teardown/deactivation hook — extensions cannot clean up timers, connections, or state ([pm-k1e4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-k1e4.toon))

### Fixed

- Extension FlagDefinition lacks 'list' and 'default' fields — extension-registered flags cannot match core comma-list contract ([pm-ltbr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ltbr.toon))

### Other

- SDK lacks assertRegisteredCommandOverride testing helper (coverage gap in testing.ts) ([pm-aw7d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-aw7d.toon))

## 2026.6.8 - 2026-06-08

### Added

- MCP pm_health defaults to the compact summary projection for token-efficient agent health checks ([pm-yjub](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yjub.toon))
- list/search: trim default filters/projection/sorting/now trailer in compact/agent mode ([pm-vhx6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vhx6.toon))
- Add schema show-status status inspection ([pm-qpus](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qpus.toon))

### Changed

- Remove dead code and dedupe pm-cli version readers into resolvePmCliVersion ([pm-wrqk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wrqk.toon))

### Fixed

- pm-changelog classifier mis-routes feature titles containing the word 'remove'/'delete' into the Removed section ([pm-ybiz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ybiz.toon))
- Fix inaccurate PR CI matrix description in CONTRIBUTING.md ([pm-t73k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-t73k.toon))
- Fix: --path/PM_PATH did not discover .agents/pm under a project root (never-block dead-end) ([pm-ryik](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ryik.toon))
- MCP ping method not handled — returns 'Unsupported MCP method' instead of empty response ([pm-lold](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lold.toon))
- MCP tools/call structuredContent.result is always present but isError path lacks it — inconsistent envelope ([pm-l40h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l40h.toon))
- MCP narrow tools silently drop top-level filter keys (pm_list {type:Task} returns unfiltered) ([pm-jozc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jozc.toon))
- CI smoke npx pack cleanup can fail with ENOTEMPTY ([pm-i2xg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i2xg.toon))
- Fix: pm close/close-many hard-failed without a reason via a generic, non-actionable error (P0 never-block) ([pm-g799](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g799.toon))
- Document pm-changelog external repo dependency and pad-match fix in RELEASING.md ([pm-97yv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-97yv.toon))
- Fix MCP tool-count doc drift (18/21 -\> 22, add pm_copy) and lock the claude-plugin smoke to the live tools/list count ([pm-7tvx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7tvx.toon))
- Drift-cache gc scope: pm gc --scope runtime should clear history-drift-cache.json ([pm-7n8v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7n8v.toon))
- writeFileAtomic cross-device rename safety: handle EXDEV when tmp and target are on different mounts ([pm-6vv6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6vv6.toon))
- list/search --tags hard-refuses (exit 2) while create --tag auto-corrects — accept --tags as a never-block alias ([pm-6l17](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6l17.toon))
- MCP server serverInfo.version is hardcoded '1.0.0' — should reflect package.json version ([pm-2nvw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2nvw.toon))

### Security

- Pin CodeQL action refs to immutable SHAs in codeql.yml ([pm-ji5c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ji5c.toon))

### Other

- 2026-06-07 agent UX package ecosystem and path guardrail hardening ([pm-yo3f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yo3f.toon))
- Ecosystem-wide PM living-context audit & forward-backlog rebuild (2026-06-07) ([pm-8u2a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-8u2a.toon))
- 2026-06-07 pm CLI ecosystem audit lanes ([pm-xm98](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-xm98.toon))
- Warn in pm health when server-advertised max telemetry schema version exceeds client version ([pm-dfhp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dfhp.toon))
- ADR: Agent self-repair via a centralized remediation registry surfaced through pm health --json and pm validate --fix-hints ([pm-cc04](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-cc04.toon))
- ADR: Test-coverage governance — 100% V8 thresholds with a curated include/exclude allowlist, a tests/unit file-count cap, and pure-logic extraction into small core modules ([pm-7sq6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-7sq6.toon))

## 2026.6.7 - 2026-06-07

### Added

- pm list --tree: recursive subtree rendering with indented hierarchy ([pm-vbzc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vbzc.toon))
- Configurable vector store collection name (post-v0.1 adapter optimization) ([pm-usw2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-usw2.toon))
- pm copy <id\>: clone an item to a new ID with optional title override ([pm-m4nn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m4nn.toon))
- Per-query hybrid weight override: pm search --semantic-weight (post-v0.1) ([pm-cy8i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cy8i.toon))
- Configurable semantic corpus character limit (search.embedding_corpus_max_characters) ([pm-cxdg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cxdg.toon))
- pm aggregate --sum/--avg: numeric aggregation over filtered items ([pm-bvns](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bvns.toon))
- Advanced relevance tuning (post-v0.1): cross-encoder reranking + query expansion ([pm-7tsx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7tsx.toon))
- pm-governance-audit: onWrite/onRead hooks exemplar (hooks capability) ([pm-7m8p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7m8p.toon))
- pm history-compact: checkpoint-based history stream compaction ([pm-3pbq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3pbq.toon))

### Fixed

- Drift-scan cache can false-hit on mtime-preserving file copies ([pm-up22](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-up22.toon))
- Track removal of TOON upstream bracket-bug workaround when upstream fix ships ([pm-idnz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-idnz.toon))
- Search relevance evaluation harness (golden queries, nDCG) for regression detection ([pm-22x2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-22x2.toon))

### Security

- Harden afterCommand coverage and GitHub code-scanning visibility ([pm-izid](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-izid.toon))

### Other

- PR \#123 review: make governance hook sidecar logging fail-open ([pm-mzlu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mzlu.toon))
- Publish pm-github starter package as a community reference (credential-requiring pattern) ([pm-zw0n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zw0n.toon))
- SDK testing helper for package manifest resource assertions ([pm-xevy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xevy.toon))
- Stabilize npx onboarding path for scoped pm package ([pm-pgew](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pgew.toon))
- Config-driven optional close reason via governance.require_close_reason ([pm-peyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-peyv.toon))
- Package install fallback hints and extension collision plans ([pm-e48i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e48i.toon))
- Agent command compatibility and package command discovery ([pm-7etc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7etc.toon))
- SDK testing helper for vector store adapter registrations ([pm-475h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-475h.toon))
- Make list --ids repeatable for focused agent working-set refresh ([pm-42tb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-42tb.toon))
- SDK testing helpers for schema package registrations ([pm-01bm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-01bm.toon))

## 2026.6.6 - 2026-06-06

### Added

- Add Claude Code rows to docs read-path and README start-here tables ([pm-pwdx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-pwdx.toon))
- pm history --diff: per-entry field-level before/after diffs ([pm-puvn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-puvn.toon))
- Create ONBOARDING.md for new maintainers and first-time contributors ([pm-oh5h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oh5h.toon))
- Add markdown broken-link check to the docs CI gate ([pm-mp6c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mp6c.toon))
- Add pm stats --storage: aggregate history-stream metrics ([pm-mnee](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-mnee.toon))
- Add MCP protocol handshake tests (initialize + tools/list + unknown-tool error) ([pm-kl11](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kl11.toon))
- Add narrow MCP tools pm_notes, pm_learnings, pm_deps (agent self-documentation + deps) ([pm-hywv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hywv.toon))
- pm telemetry local-analytics subcommand (status/flush/stats/clear) ([pm-6xdl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6xdl.toon))
- Add AGENTS.md/README workflow-update checkbox to the PR template ([pm-0sqs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0sqs.toon))

### Changed

- Export PM_TOOL_PARAMETERS_SCHEMA_VERSION constant and bind all assertion sites ([pm-r9sz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r9sz.toon))
- Generate pm_run action-list description from PM_TOOL_ACTIONS to end prose/enum drift ([pm-fd8n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fd8n.toon))

### Fixed

- MCP TOOL_SCHEMA_BASE additionalProperties:true silently swallows typo'd top-level args ([pm-qxwu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qxwu.toon))
- File-backed schema sections (types/statuses/fields/type_workflows) leak into settings.json on writeSettings ([pm-haak](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-haak.toon))
- Add pm gc --scope locks: sweep expired lock debris from crashed processes ([pm-d70h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d70h.toon))
- PRD/contract drift: reminders_weight and events_weight missing from search.tuning docs ([pm-75du](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-75du.toon))
- MCP stdio server processes JSON-RPC lines concurrently → pipelined mutations on the same item lock-conflict ([pm-3puw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3puw.toon))

### Other

- MCP & contract platform maturity PR (pm-5k4v): narrow tools pm_notes/pm_learnings/pm_deps + schema-base hardening + action-list drift-gen + schema-version constant + handshake tests ([pm-at83](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-at83.toon))
- Document capture_level semantics for extension authors ([pm-te9x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-te9x.toon))
- Telemetry schema versioning/negotiation preparation ([pm-t4wb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t4wb.toon))
- History & storage observability: pm gc locks scope, pm history --diff before/after, pm stats --storage ([pm-l709](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-l709.toon))
- Document the create vs mutateItem dual write-path contract ([pm-k5r6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k5r6.toon))
- Drift-lock the .agents/plugins/marketplace.json (pm-local) manifest in the plugin contract test ([pm-g3xl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-g3xl.toon))
- Clean up stale closed tracker-item references in docs/ header lines ([pm-e376](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-e376.toon))
- Contract schema golden-file snapshot gate in CI ([pm-d6kq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-d6kq.toon))
- Evaluate commander 15.0.0 major upgrade (current 14.0.3) ([pm-7j8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7j8t.toon))
- Document changelog classifier keyword routing for contributors ([pm-5vsv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5vsv.toon))

## 2026.6.5 - 2026-06-05

### Added

- pm list --updated-after/--created-after incremental date filters ([pm-y138](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-y138.toon))
- Reusable external npm package ecosystem smoke harness ([pm-vnjh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vnjh.toon))
- First-party hooks capability exemplar (lifecycle hook) for pm-izsi completion ([pm-s40s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-s40s.toon))
- Add generic create/update setter for extension item fields ([pm-qvdj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qvdj.toon))
- pm schema list / pm schema show: inspect registered custom and built-in types ([pm-qq69](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qq69.toon))
- pm close-many: bulk-close matched items with shared reason and validate-close semantics ([pm-i17g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i17g.toon))
- Per-type workflow / allowed-transitions config (schema/workflows.json) ([pm-f4r1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f4r1.toon))
- pm search --status filter (parity with pm list) ([pm-ec4s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ec4s.toon))
- pm schema add-status: register custom statuses (complement to add-type) ([pm-e77a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e77a.toon))
- pm validate --fix-hints: machine-executable remediation commands per check ([pm-6m3y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6m3y.toon))
- pm init --type-preset agile\|ops\|research: batch-register domain item types ([pm-1lkm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1lkm.toon))
- pm update-many --ids: explicit ID-list filter for targeted bulk mutations ([pm-1h99](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1h99.toon))
- Structured remediation map on pm health --json for all non-extension checks ([pm-0hnu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0hnu.toon))

### Changed

- 2026-06-02 commander SDK custom-field and extension-output hardening ([pm-lwtx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lwtx.toon))

### Fixed

- Auto Release 2026-06-01 tagged v2026.6.1 but npm publish never completed (latest npm = 2026.5.31) ([pm-kcba](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kcba.toon))
- Sentry reliability gate blocks release on dogfood-generated expected CLI errors (brittle per-count + missing standup-export patterns) ([pm-yohx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yohx.toon))
- governance.create_default_type is not settable via pm config set ([pm-jpwo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jpwo.toon))
- Fix GitHub \#98 dependency --dep type parsing ([pm-dlfq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dlfq.toon))
- Warn on global service and renderer override footguns ([pm-5teq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5teq.toon))

### Removed

- pm schema remove-type: delete a custom type from types.json ([pm-k8ik](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k8ik.toon))

### Other

- 2026-06-02 latest-main ecosystem dogfood and SDK review ([pm-kddw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kddw.toon))
- After-command hook affected item transition context ([pm-qzv2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qzv2.toon))
- Agent context & bulk-ops primitives: incremental date filters, search --status, --ids targeting, close-many ([pm-j2ig](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-j2ig.toon))
- Sentry gate expected handled CLI classifier refresh ([pm-flbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-flbo.toon))
- SDK extension hook context and manifest capability guardrails ([pm-e9ut](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e9ut.toon))
- Surface settings_read_invalid_schema warning proactively on affected commands ([pm-7tcw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7tcw.toon))

## 2026.6.2 - 2026-06-02

### Added

- pm-todos + pm-beads: migrate to registerImporter/registerExporter (importers capability exemplar) ([pm-13bn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-13bn.toon))
- pm-search-advanced: register a built-in SearchProvider exemplar (search capability) ([pm-bqpg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bqpg.toon))
- First-class importer/exporter registration: registerImporter/registerExporter accept command metadata (description/flags/intent/examples) ([pm-7qjk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7qjk.toon))

### Other

- 2026-06-01 package ecosystem SDK agent UX audit and hardening ([pm-z0ip](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z0ip.toon))
- 2026-05-31 late latest-main ecosystem dogfood and review closure ([pm-etxf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-etxf.toon))

## 2026.6.1 - 2026-06-01

### Added

- SDK ergonomics: package-safe error base, version negotiation, document PM_CLI_PACKAGE_ROOT ([pm-oxyo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oxyo.toon))
- Declare pm_min_version in all 8 first-party package manifests ([pm-nf2q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nf2q.toon))
- Extend SDK testing helpers to cover hooks, search providers, importers/exporters ([pm-kfd8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kfd8.toon))
- Build package-first pm ecosystem and install command ([pm-59gj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-59gj.toon))
- Extension manifest pm_max_version (upper compatibility bound) ([pm-4gw6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4gw6.toon))

### Changed

- Vector store: prune orphans on reindex + reset on embedding-model/dimension change ([pm-xutw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xutw.toon))
- Dedup create/update parsers + optional command-file splits ([pm-8ehg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8ehg.toon))

### Fixed

- Calendar: normalize recurrence exdates by instant + document count-window semantics ([pm-qcsz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qcsz.toon))

### Security

- ADR: Extension sandbox profiles are advisory governance attestations, not enforced isolation ([pm-6ef3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-6ef3.toon))

### Other

- Ecosystem PM living-map audit & reorganization methodology ([pm-knqw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-knqw.toon))
- Runtime-resolved shell completion for custom statuses/types via helper command ([pm-q4zx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q4zx.toon))
- Lazy extension activation: defer import+activate until a command needs contributions ([pm-5wb6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5wb6.toon))
- Ecosystem-wide PM living-context map: audit, ADRs, roadmap, and forward backlog (2026-05-31) ([pm-w7f2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-w7f2.toon))
- Verify living-map: ecosystem coverage gaps ([pm-xmhn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xmhn.toon))
- ADR: Stable CLI exit-code contract (0 success, 1 generic, 2 usage, 3 not_found, 4 conflict, 5 dependency_failed) ([pm-x1z3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-x1z3.toon))
- ADR: Three-tier metadata cache (light scalars / bodies / collections) keyed by file stat ([pm-vnie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-vnie.toon))
- ADR: Non-blocking background semantic refresh (detached worker + reindex lock) ([pm-vizt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-vizt.toon))
- ADR: Two extension-authoring idioms: defineExtension (package mode) vs import-free JSDoc (extension-only) ([pm-vb5a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-vb5a.toon))
- Verify living-map: hierarchy, dependencies & ADR coverage ([pm-uid0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uid0.toon))
- ADR: Dependency-free settings validator (replaced zod on the hot path) ([pm-u7xx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-u7xx.toon))
- ADR: First-party packages ship hand-maintained .js alongside .ts (no per-package build) ([pm-tsio](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-tsio.toon))
- ADR: TOON as canonical item storage; JSON-Markdown is legacy read-only ([pm-rvbt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-rvbt.toon))
- Audit domain: MCP server, SDK & contracts ([pm-rpc3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rpc3.toon))
- ADR: Hand-rolled dependency-free MCP server (JSON-RPC over stdio) ([pm-pif3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-pif3.toon))
- ADR: Product vision & guiding principle — project management = context management ([pm-oxq5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-oxq5.toon))
- ADR: Governance presets (minimal/default/strict/custom) as the primary config surface ([pm-ouvu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-ouvu.toon))
- Audit domain: Docs, onboarding, release, changelog & CI ([pm-obxz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-obxz.toon))
- Audit domain: Extensions, packages & SDK extension API ([pm-n15j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-n15j.toon))
- ADR: Local-first telemetry with 'redacted' capture as the privileged default ([pm-mplj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-mplj.toon))
- Audit domain: Telemetry, observability, Sentry, health/validate ([pm-kxw0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kxw0.toon))
- ADR: Compact-by-default is the agent path at the MCP boundary ([pm-ko1g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-ko1g.toon))
- 2026-05-31 external package audit and agent contract hardening ([pm-kd9n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kd9n.toon))
- ADR: Health checks are advisory vs blocking: telemetry\_\* never flips ok:false ([pm-jezo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-jezo.toon))
- ADR: Startup-latency strategy (prebuilt JS, lazy per-command imports, external deps, no single bundle) ([pm-irp1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-irp1.toon))
- ADR: Git-native filesystem is the database (one file per item; no server, daemon, or DB engine) ([pm-i7i4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-i7i4.toon))
- Audit domain: Core CLI command surface & item lifecycle ([pm-hqka](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hqka.toon))
- ADR: Append-only JSONL history with SHA-256 hash chain ([pm-hg0k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-hg0k.toon))
- Audit domain: Search & semantic (keyword/semantic/hybrid, embeddings, vector stores) ([pm-h7n6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h7n6.toon))
- Living-map verification & gap-closure pass (continuation, 2026-05-31) ([pm-h31a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h31a.toon))
- Verify living-map: dedup & definition quality ([pm-f6rm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f6rm.toon))
- Governance test: enforce manifest pm_min_version and manifest_version on all first-party packages ([pm-exrw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-exrw.toon))
- ADR: Date-based calendar versioning with daily automated release and manual same-day follow-ups ([pm-ee1k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-ee1k.toon))
- ADR: Expected-error classification keeps Sentry signal-to-noise high ([pm-c8qa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-c8qa.toon))
- ADR: Never-block agent UX: high-frequency aliases are executable bootstrap rewrites, not suggestion text ([pm-bwlz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-bwlz.toon))
- Audit domain: Storage, item-store, history, TOON, restore ([pm-ar08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ar08.toon))
- ADR: Config-driven runtime schema (4-file model) over hard-coded type/status/field registries ([pm-a859](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-a859.toon))
- ADR: Plugin hybrid model: pm is the git-native store; the editor/agent panel is a live session view ([pm-7c4t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-7c4t.toon))
- ADR: CHANGELOG is auto-generated from closed items by pm-changelog; never hand-edited ([pm-6san](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-6san.toon))
- ADR: Hybrid search = normalized linear interpolation with a configurable weight ([pm-66ig](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-66ig.toon))
- Audit domain: Config, schema, custom types & init ([pm-4uxz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4uxz.toon))
- Refresh changelog after PR closeout merge ([pm-2y28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2y28.toon))
- ADR: Single-source contracts: cli-contracts.ts is the authoritative CLI+MCP+contracts surface ([pm-2evy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-2evy.toon))
- ADR: LanceDB pure-JSON snapshot vector store (no native bindings) ([pm-164t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-164t.toon))
- ADR: Collision-checked random short IDs (configurable prefix + base36 token) ([pm-12j1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-12j1.toon))

## 2026.5.31 - 2026-05-31

### Added

- Non-blocking background search index refresh on mutations ([pm-3ju0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3ju0.toon))

### Changed

- Per-command code-splitting: lazy command-module imports drop the 943KB monolith + fast-glob from the read path ([pm-t57d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-t57d.toon))

### Fixed

- pm health ok:false from legacy unused 'index' required subdir ([pm-yf31](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yf31.toon))
- Fix per-type default_status config was silently ignored at create ([pm-y0gl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-y0gl.toon))
- Fix slow/oversized local vector snapshot and mislabeled search fallback ([pm-f58e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-f58e.toon))
- Calendar date math is UTC-only: ignores event.timezone and all-day semantics ([pm-0l88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0l88.toon))
- Fix Windows npm command resolution for extension package installs ([pm-arax](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-arax.toon))

### Other

- Make MCP status enum + shell completion runtime-resolved from schema (not hardcoded) ([pm-jtdc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jtdc.toon))
- Calendar view/format did-you-mean + dependency and type-safety cleanup ([pm-5oxq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5oxq.toon))
- Defer eager per-command startup work: completion flag-strings, MCP tool schema build, telemetry flush spawn ([pm-3mal](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3mal.toon))
- 2026-05-30 package SDK dogfood audit and startup telemetry performance pass ([pm-qmx3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qmx3.toon))

## 2026.5.30 - 2026-05-30

### Added

- Reduce ESM module-resolution startup overhead (~85ms) via core bundling ([pm-ss1d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ss1d.toon))

### Fixed

- Calendar positional-date and impossible-deadline UX: pm calendar 2026-06-15 hard-errors; --deadline 2026-02-30 silently rolls to Mar 2 ([pm-wr74](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wr74.toon))
- Split metadata cache into light + collections tiers to cut list hot-path JSON parse ([pm-jd3v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jd3v.toon))
- Semantic index not auto-refreshed on mutation: create then pm search --semantic misses the new item (stale index) ([pm-bpaj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bpaj.toon))
- create's schedule-less calendar hint suggests rejected --event pipe form (accepts CSV) — blocks agents ([pm-8c2s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8c2s.toon))
- Suggestion-only command aliases (show/comment/note/view) still hard-fail as nonexistent_command instead of executing ([pm-7by2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7by2.toon))
- create rejects common type synonyms (Bug/bug, Change/change) instead of mapping to Issue/Chore ([pm-4d1b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4d1b.toon))
- Semantic auto-defaults are all-or-nothing: one config leaf disables ALL defaults and hard-errors reindex ([pm-407c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-407c.toon))

### Other

- CLI perf, simplification, and best-practice remediation (2026-05-27) ([pm-th6y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-th6y.toon))

## 2026.5.29 - 2026-05-29

### Added

- Calendar best-practice: honor timezone, surface Milestone/Meeting items, ICS export ([pm-xzrx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xzrx.toon))
- Model-agnostic search: provider settable via pm config + docs + index staleness surfacing ([pm-7ilo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7ilo.toon))

### Changed

- Code-quality refactors: split runUpdate/runCreate, cli-contracts barrel, shared dedup helpers, drop dead exports ([pm-1b96](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1b96.toon))

### Fixed

- pm comments/notes/learnings --add HTML-escapes angle brackets in stored text ([pm-ydkl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ydkl.toon))
- MCP pm_create/pm_update crashed with 'raw.trim is not a function' when priority was sent as a JSON number ([pm-9r7z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9r7z.toon))
- pm update doesn't accept --expected/--actual aliases that pm close accepts ([pm-1lws](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1lws.toon))

## 2026.5.28 - 2026-05-28

### Fixed

- Minor UX/correctness: test --add wording, dep-kind vocab, same-command did-you-mean, plan materialize, close inline resolution, scaffold defineExtension ([pm-fl0c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fl0c.toon))
- Agent-UX footguns: create-type silent mistype + token-bloat in validate/search output ([pm-edge](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-edge.toon))

## 2026.5.27 - 2026-05-27

### Added

- Bundle CLI with esbuild for sub-200ms startup ([pm-gt82](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gt82.toon))
- Add pm config set positional value form and shorten the invalid config-key error ([pm-mf4j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mf4j.toon))
- Add --no-changed-fields flag and compact MCP mutation output to drop the redundant changed_fields array ([pm-ch59](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ch59.toon))
- Cut list/search latency: skip 4.9MB cache rewrite + drop bodies + onRead short-circuit ([pm-4r5t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4r5t.toon))

### Changed

- Split large command files exceeding 2000 LOC ([pm-mbdu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mbdu.toon))
- Deduplicate item/metadata to record widening casts behind a shared toItemRecord helper ([pm-p5if](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p5if.toon))

### Fixed

- pm-changelog generator silently drops items the bundled @unbrained/pm-cli SDK cannot read ([pm-hybj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hybj.toon))
- Surface extension command handler error messages instead of opaque extension_command_handler_failed code ([pm-zwl7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zwl7.toon))
- Fix Auto Release failure: build dist before pm-changelog generation runs ([pm-yf8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yf8t.toon))
- Calendar: improve positional view UX (PM-CLI-Z Sentry) ([pm-nb68](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nb68.toon))
- Address pre-existing extension/SDK issues surfaced by PR \#69 review (CodeRabbit) ([pm-ll50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ll50.toon))
- Handle concurrent project package installs without EEXIST ([pm-hw6z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hw6z.toon))
- Repeated loose-mapped --tag flags silently keep only the last value (agent-unfriendly) ([pm-cf1u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cf1u.toon))
- Improve unknown-option recovery with nearest, abbreviated, and cross-command flag suggestions plus list --sort aliases ([pm-8nyc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8nyc.toon))
- pm health takes 8s and reports ok:false due to blocking telemetry flush to unreachable endpoint ([pm-1lgy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1lgy.toon))

### Security

- Add audited history-stream redaction command ([pm-xk39](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xk39.toon))
- Latest CLI quality, SDK, telemetry, search, and calendar remediation ([pm-rnpb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rnpb.toon))
- Harden extension install against path traversal and fill missing health/validate MCP schema props ([pm-qhu4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qhu4.toon))

### Other

- Deduplicate beads/todos index.ts package-runtime loader (install-safe mechanism needed) ([pm-wwa7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wwa7.toon))
- Deduplicate Beads and Todos package adapter runtimes ([pm-ybfj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ybfj.toon))
- Deduplicate bundled package runtime option parsing helpers ([pm-y5u0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-y5u0.toon))
- Code dedup: extract shared CLI parser blocks and consolidate item-record casts ([pm-why9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-why9.toon))
- Single-source extension capability and policy-surface contract lists ([pm-w98k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-w98k.toon))
- Harden read-then-lock window uniformly across history-redact/restore/history-repair ([pm-uer0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-uer0.toon))
- Docs hygiene: stop shipping PRD.md in npm package, dedupe PRD<-\>docs, slim CHANGELOG, reconcile marketplace.json ([pm-rjgh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-rjgh.toon))
- Dedupe history-redact + history-repair lock+ownership scaffolding ([pm-kbm9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-kbm9.toon))
- Deduplicate files/docs linked-resource command implementations ([pm-jzf4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jzf4.toon))
- Code-quality & dead/duplicate code audit (2026-05-27) ([pm-jvbt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jvbt.toon))
- Deduplicate Claude and Codex plugin MCP wrappers and smoke flows ([pm-js0r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-js0r.toon))
- Release @unbrained/pm-cli 2026.5.24 ([pm-jpfc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jpfc.toon))
- Extract shared legacy settings test fixtures ([pm-ibyi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ibyi.toon))
- Extract reusable semantic HTTP mock fixtures ([pm-gvk2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gvk2.toon))
- Manual real-world E2E dogfood of full pm CLI surface (2026-05-27) ([pm-gqx7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gqx7.toon))
- Single-source Codex plugin docs tool surface ([pm-d97r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-d97r.toon))
- Single-source extension governance policy defaults ([pm-axd1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-axd1.toon))
- Unify plugin/MCP naming: pm-cli-claude→pm-claude, pm-cli-codex→pm-codex, pm-cli-native MCP→pm-mcp, packages @unbrained/pm-package-X→@unbrained/pm-X ([pm-ash0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ash0.toon))
- Generate full historical CHANGELOG.md through pm-changelog ([pm-afl9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-afl9.toon))
- Calendar + SDK + vector-search + docs review (2026-05-27) ([pm-a0w4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-a0w4.toon))
- Agent-UX combined PR: compact mutation output (pm-ch59) + smarter unknown-flag recovery (pm-8nyc) ([pm-70mi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-70mi.toon))
- Dogfood 2026-05-20 low-severity CLI polish backlog (config UX, init verbosity, help alias bloat, default-safety, doc/validator drift) ([pm-5k2w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5k2w.toon))
- Verify and repair pm-changelog-generated main CHANGELOG release alignment ([pm-5baq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5baq.toon))
- Single-source guide-shell routing snippets across docs ([pm-48vd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-48vd.toon))
- Single-source Plan workflow examples across plugin docs ([pm-3y56](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3y56.toon))
- Keep large modules maintainable via barrel re-export splits + explicit uncovered allowlist ([pm-3cbk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-3cbk.toon))
- Single-source extension manifest and policy examples in docs ([pm-2awd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2awd.toon))
- Bump @sentry/node 10.53.1 to 10.54.0 ([pm-0g2p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0g2p.toon))
- Single-source Claude plugin capability inventory docs ([pm-0d0q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0d0q.toon))
- Create native Codex plugin for pm CLI ([pm-0c9q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0c9q.toon))

## 2026.5.24 - 2026-05-24

### Added

- pm schema add-type CLI + invalid-type error hint (pm-e1va) ([pm-fy8o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-fy8o.toon))
- Default-safety policy for destructive pm commands (gc keeps delete-by-default; add pm delete --dry-run) ([pm-tobi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-tobi.toon))
- Config-driven custom item types: wire schema/types.json into runtime schema ([pm-e1va](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e1va.toon))

### Fixed

- pm update/create --test shares the B2 silent key-corruption (no cmd alias, no unknown-key rejection) ([pm-swie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-swie.toon))
- Linked test sandbox cleanup can fail with ENOTEMPTY ([pm-u43m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u43m.toon))
- Auto daily release silently skips releasable commits when CHANGELOG \[Unreleased\] is empty ([pm-ot8r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ot8r.toon))
- pm update --blocked-by does not create a pm deps graph edge ([pm-kyd6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kyd6.toon))
- Recover 16 unreadable TOON item files: strict decoder mis-parses bracketed tokens followed by a colon inside quoted text fields ([pm-iqgj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-iqgj.toon))
- pm-changelog extension fails on large tracker JSON ([pm-bu50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bu50.toon))

### Removed

- CLI ergonomics polish: concise init, help alias collapse, named priorities, package install hints, starter templates, delete dry-run ([pm-fuat](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-fuat.toon))
- Deduplicate item-store mutation and delete lifecycle setup ([pm-za3c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-za3c.toon))

### Security

- Deduplicate path containment helpers across package and extension code ([pm-dpzc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dpzc.toon))
- Update npm dependencies: minor version bumps (sentry/cli, toon, node types, vitest, tsx) ([pm-a2g6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-a2g6.toon))

### Other

- history-repair command + legacy drift cleanup + replay dedup ([pm-c3dx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-c3dx.toon))
- Deduplicate templates package runtime and legacy command implementation ([pm-ypqp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ypqp.toon))
- Deduplicate mutation author fallback resolution across commands ([pm-xh0y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xh0y.toon))
- Deduplicate item-type definition normalization across settings and registry ([pm-v798](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-v798.toon))
- Calendar agent ergonomics: equal start/end rejected; schedule-less Event items invisible ([pm-uzmf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-uzmf.toon))
- Deduplicate health and validate history-drift checks ([pm-qsk8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-qsk8.toon))
- Centralize audit ownership-conflict guidance ([pm-ols6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ols6.toon))
- Deduplicate recurrence weekday ordering helper ([pm-max1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-max1.toon))
- Extract shared extension fixture writer for tests ([pm-j15d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-j15d.toon))
- Deduplicate runtime terminal-status checks across query commands ([pm-i04b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-i04b.toon))
- Dogfood 2026-05-21 follow-ups: test --add key validation, semantic-fallback labeling, close active-children info, stale blocker on close ([pm-fu5d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fu5d.toon))
- Extract shared test item factories for command specs ([pm-eltf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eltf.toon))
- Deduplicate lazy dynamic-import cache boilerplate in CLI registration ([pm-c98b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-c98b.toon))
- Extract shared JSON error-envelope test assertions ([pm-alqo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-alqo.toon))
- Deduplicate comments, notes, and learnings command stacks ([pm-9y8q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-9y8q.toon))
- Deduplicate front-matter key-order contract literals in tests ([pm-8fx3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8fx3.toon))
- Extract shared temporary-directory lifecycle helpers for tests ([pm-7tug](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7tug.toon))
- Install and validate pm-changelog package ([pm-7811](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7811.toon))
- Extract shared direct CLI spawn helper for integration tests ([pm-401l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-401l.toon))

## 2026.5.23 - 2026-05-23

### Changed

- Remove dead code: command-aware.ts module, 5 orphaned exported functions, unused undici dependency ([pm-b7do](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-b7do.toon))

### Fixed

- MCP pm_search defaults to full item bodies, blowing past agent token limits ([pm-qrxs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qrxs.toon))
- pm create --blocked-by stores free-text metadata, not a dependency edge or blocked status (agent-confusing) ([pm-orrl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-orrl.toon))
- pm health output stays large even with --brief/--skip flags; add a true one-line summary mode ([pm-nbht](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nbht.toon))
- Calendar: pm cal <view\> --date crashes (positional view + any flag) ([pm-l292](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l292.toon))
- Agent UX: pm update --status closed, explicit semantic/hybrid search, and pm create <type\> <title\> must never block agents ([pm-j1v7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j1v7.toon))
- Sentry PM-CLI-R/PM-CLI-S: undefined-status .trim and undefined-tags .join crashes (fixed in HEAD, mark resolvedInNextRelease) ([pm-d7us](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d7us.toon))
- Dogfood 2026-05-20: CLI/agent-UX consistency fixes (append text forms, scope errors, --list parity, command typo suggestions) ([pm-atsv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-atsv.toon))
- MCP pm_run activity defaults to verbose raw history-patch dump (token waste for agents) ([pm-8jd3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8jd3.toon))
- Audited history-repair (re-anchor) command + clear legacy history drift so pm health is ok ([pm-85hm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-85hm.toon))
- MCP pm_comments returns full comment history (no default limit) — token bloat on long-lived items ([pm-6vfg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6vfg.toon))
- pm plan: materialize creates dependency cycle; decision/discovery/validation flag mismatch; --steps all unsupported ([pm-6blp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6blp.toon))
- Reduce default verbosity of pm activity/history CLI output and add a compact mode to pm history ([pm-3pbs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3pbs.toon))

### Security

- Harden secret-scan guardrail for GitHub token prefixes and local credential hygiene ([pm-h4zb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h4zb.toon))

### Other

- Session 2026-05-23: agent-UX + deps-graph integrity batch (multi-agent) ([pm-uz25](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-uz25.toon))
- Deduplicate history, restore, and redaction replay helpers ([pm-pjs5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-pjs5.toon))
- pm validate: ok:false on warn-only checks + dumps every item ID per field ([pm-1nht](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1nht.toon))

## 2026.5.18 - 2026-05-18

### Added

- pm claim --if-available (skip when held) — reduce 533 ownership_conflict events ([pm-d4bo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-d4bo.toon))
- pm list should default to --brief (full output via --full) to halve token cost ([pm-b7sd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-b7sd.toon))
- pm get/show: did-you-mean suggestions for unknown IDs (telemetry: 233 hits/30d) ([pm-99x5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-99x5.toon))
- pm init footer + bundle calendar so cal/templates are discoverable ([pm-8wwl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8wwl.toon))
- pm update with no fields should noop-succeed, not fail (telemetry: 128 hits/30d) ([pm-7cup](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7cup.toon))
- Auto-route pm update --status closed --close-reason to pm close (telemetry: 248 hits/30d) ([pm-12ib](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-12ib.toon))
- Add pm plan list subcommand or did-you-mean to pm list --type Plan ([pm-zpa5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zpa5.toon))
- Add agent-optimized pm plan command with linked dependencies ([pm-v7dj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v7dj.toon))
- Drastically improve GitHub runner time and resource usage (free-tier only) ([pm-tzwy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tzwy.toon))
- Add built-in Plan item type and storage/search integration ([pm-jauk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jauk.toon))
- Add --with-packages flag to pm init for one-shot package install ([pm-hosd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hosd.toon))
- Add pm init checks for AGENTS/CLAUDE pm workflow guidance ([pm-7t04](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7t04.toon))

### Fixed

- MCP pm_context crashes on caller-supplied projection flags (compact/brief/fields/includeBody) ([pm-xy02](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xy02.toon))
- pm install <invalid\> lacks did-you-mean for built-in aliases ([pm-uuee](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-uuee.toon))
- pm validate after fresh create is scary — downgrade default profile noise ([pm-tylj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tylj.toon))
- auto-release.yml workflow_dispatch silently overrides explicit push=false to true ([pm-qa2h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qa2h.toon))
- pm contracts default returns 286 KB / 9612 lines — token catastrophe for agents ([pm-p8j6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p8j6.toon))
- Sentry extension errors: cannot find module and activate failures ([pm-p7av](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p7av.toon))
- pm install exits 0 on error (CRITICAL agent-blocker) ([pm-naiv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-naiv.toon))
- CLI silently corrupts --tags '\["a","b"\]' JSON-array input (agent-unfriendly) ([pm-klqo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-klqo.toon))
- Embedding timeout UX: improve ollama feedback for PM-CLI-A/9 ([pm-ibp7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ibp7.toon))
- pm bare command silent exit 0 — no help shown ([pm-8rj2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8rj2.toon))
- Investigate validate/health telemetry classification (71-74% failure rate) ([pm-bzx3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bzx3.toon))
- Accept positional title argument in pm create ([pm-7vm9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7vm9.toon))
- Fix CSV status filter and multi-status support in pm list ([pm-ziv0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ziv0.toon))
- Clean project linked-file validation hygiene ([pm-xz1p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xz1p.toon))
- pm install writes absolute-home-path into tracked .managed-extensions.json ([pm-u83w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u83w.toon))
- Perf: pm health takes 2.5s due to vectorization check ([pm-tibg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tibg.toon))
- MCP pm_update --comment string crashes with 'values.map is not a function' ([pm-qeu1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qeu1.toon))
- Fix TOON array-of-objects continuation lines double-indent ([pm-ps85](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ps85.toon))
- Default project scope for files/docs/tests and simplify scope UX ([pm-ntnf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ntnf.toon))
- Telemetry queue tmp file orphan cleanup (83MB stale) ([pm-nhka](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nhka.toon))
- CI: cache .agents/pm/search/lancedb + sentry release cache ([pm-n28v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-n28v.toon))
- CI: smaller matrix on PRs, full matrix on main push only ([pm-lkd7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lkd7.toon))
- Cache item body in metadata cache for fast keyword search ([pm-jw36](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jw36.toon))
- Stop listing provided --flag as missing in error recovery bundle ([pm-ixi1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ixi1.toon))
- CI: skip non-source jobs on docs-only changes ([pm-iv1u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-iv1u.toon))
- CI: combine pnpm test + pnpm test:coverage into single coverage run ([pm-hpjd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hpjd.toon))
- pm test --add causes immediate history drift via null timeout_seconds ([pm-er4q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-er4q.toon))
- Fix: ENOENT lstat in extension path operations ([pm-bh13](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bh13.toon))
- Fix: localeCompare on undefined in sort comparators ([pm-b9y1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b9y1.toon))
- Suppress benign extension_service_override_collision when calendar+guide-shell both bundled ([pm-5u9z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5u9z.toon))
- MCP pm_list defaults to compact projection for agents ([pm-2cqx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2cqx.toon))
- CI: split quality+smoke gates into a parallel job, share dist via artifact ([pm-27yz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-27yz.toon))
- CI: cache vitest/.cache + tsbuildinfo for incremental builds + faster tests ([pm-1pah](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1pah.toon))
- Add regression coverage for pm init agent guidance workflows ([pm-0nia](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0nia.toon))

### Other

- Dogfood + remediation session 13 (2026-05-17) ([pm-vmeo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-vmeo.toon))
- Smoke test after audit ([pm-xmsn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xmsn.toon))
- 2026-05-03 latest PM CLI dogfood audit ([pm-jrjt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-jrjt.toon))
- Implement pm plan command family for agent harness workflows ([pm-ze5g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ze5g.toon))
- Accept positional title for pm plan create like pm create does ([pm-qbts](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qbts.toon))
- Accept pm init --yes alias for --defaults ([pm-lwbr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lwbr.toon))
- Build idempotent AGENTS/CLAUDE pm guidance detector and writer ([pm-g2nd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g2nd.toon))
- Release @unbrained/pm-cli after 2026.5.12 ([pm-dc5d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dc5d.toon))
- Expose agent guidance init option in settings, contracts, help, and config ([pm-b8rf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b8rf.toon))
- Expose Plan workflow in SDK, MCP, plugins, docs, and dogfood ([pm-aqat](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-aqat.toon))
- Wire pm init approval flow and declined guidance persistence ([pm-8rjn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8rjn.toon))
- Implement pm guide docs and skills modernization ([pm-4z9m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4z9m.toon))
- Merge Dependabot PRs: dev+prod deps and pnpm/action-setup ([pm-2723](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2723.toon))
- Opt CI JavaScript actions into Node 24 runtime ([pm-1lef](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1lef.toon))
- Document pm init agent guidance context workflow ([pm-1265](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1265.toon))

## 2026.5.14 - 2026-05-14

### Added

- Add reusable package-first temp-project dogfood script ([pm-8l7d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8l7d.toon))
- Publish package gallery and marketplace metadata ([pm-2b3l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2b3l.toon))

### Changed

- Extract guide and completion UX into installable package ([pm-zjuv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zjuv.toon))
- Extract calendar UX into installable pm package ([pm-pznn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pznn.toon))
- Extract governance audit surfaces into installable package ([pm-ixt3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ixt3.toon))
- Define linked test runner package boundary ([pm-7xk5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7xk5.toon))
- Extract advanced search and vectorization into installable pm package ([pm-2rj1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2rj1.toon))
- Extract create templates into installable pm package ([pm-2fgn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2fgn.toon))

### Fixed

- Hybrid semantic reindex should emit bounded progress and deterministic JSON completion ([pm-6zqq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6zqq.toon))
- Expose runtime command-path state in extension explore ([pm-5mua](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5mua.toon))
- Sync package JS runtimes to public SDK surface ([pm-2t78](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2t78.toon))

### Other

- Decouple optional package actions from static SDK contracts ([pm-wxxv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wxxv.toon))
- Design full pm package manifest and resource model ([pm-t5ud](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t5ud.toon))
- Migrate extension terminology to package-first docs and UX ([pm-lwun](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-lwun.toon))
- Expose package runtime helpers through public SDK ([pm-hkql](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hkql.toon))
- Simplify command inputs for setup-agnostic agent workflows ([pm-ej01](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ej01.toon))

## 2026.5.12 - 2026-05-12

### Added

- Generalize pm package resources for project-management extensions ([pm-su6i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-su6i.toon))
- Add package-first command aliases and pm install ([pm-9x1c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9x1c.toon))

### Fixed

- Suppress linked-test sandbox ENOENT seed races ([pm-kk4t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kk4t.toon))

### Other

- Extract bundled import/export customizations into installable pm packages ([pm-hxp2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hxp2.toon))
- Run package-first CLI and SDK temp-project E2E ([pm-gy6w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gy6w.toon))
- Classify barebone core boundary and package migration matrix ([pm-c933](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-c933.toon))
- Implement pm upgrade for CLI, SDK, and packages ([pm-bob2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bob2.toon))
- Stop tracking runtime metadata cache ([pm-4det](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4det.toon))

## 2026.5.11 - 2026-05-11

### Fixed

- Fix Claude plugin smoke marketplace contract ([pm-sw92](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sw92.toon))
- Profile and optimize command startup latency ([pm-m4ov](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m4ov.toon))

### Other

- Full-scope SDK and extension platform upgrade for app/CI integrations ([pm-dhie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dhie.toon))

## 2026.5.10 - 2026-05-10

### Added

- Comments shorthand compatibility and docs parity ([pm-cvwi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cvwi.toon))

### Security

- 2026-05-09 latest-build full pm CLI dogfood audit and remediation ([pm-m35h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m35h.toon))

## 2026.5.6 - 2026-05-06

### Fixed

- GitHub \#20: resilient mixed-frontmatter item-format migration ([pm-w5j7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-w5j7.toon))
- GitHub \#21: document resilient global git-install recovery ([pm-drje](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-drje.toon))

### Other

- Release @unbrained/pm-cli after 2026.5.4 ([pm-0rjf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0rjf.toon))

## 2026.5.3-2 - 2026-05-04

### Other

- Release @unbrained/pm-cli after 2026.5.2 ([pm-0qv7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0qv7.toon))

## 2026.5.3 - 2026-05-03

### Changed

- main.ts still has 4 extraction candidates (~1325 lines) ([pm-sh6o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sh6o.toon))
- Code quality review - latest refactor surface ([pm-zk79](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zk79.toon))
- Code quality + architecture review with targeted tests ([pm-lvww](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lvww.toon))
- Duplicated parseLimit/parsePriority/parseType across 8+ command files ([pm-hb8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hb8t.toon))

### Fixed

- Blocker: telemetry endpoint returning HTTP 521 ([pm-ut35](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ut35.toon))
- UX: Telemetry shows 84 'No update flags provided' errors - improve guidance ([pm-sh4x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sh4x.toon))
- PmCliError events leaking to Sentry via captureConsoleIntegration ([pm-9iho](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9iho.toon))

### Security

- Execute latest dogfood audit and targeted fixes ([pm-mm3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mm3h.toon))
- Security/privacy leakage gate - redact host/IP/token from tracked files ([pm-m0fh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m0fh.toon))
- Pin GitHub Actions to immutable SHAs ([pm-hfny](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hfny.toon))

### Other

- 2026-05-03 Full PM CLI Re-Audit (Live Cycle) ([pm-476d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-476d.toon))
- 2026-05-02 Comprehensive PM CLI Audit (v2026.5.2) ([pm-5zkg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-5zkg.toon))
- Telemetry + Sentry analysis and remediation ([pm-xwl6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xwl6.toon))
- Calendar + agent output audit ([pm-wyvu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wyvu.toon))
- Decision: Re-audit final verification and system health summary ([pm-tdo5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-tdo5.toon))
- CI: make package test scripts sandbox-first ([pm-swja](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-swja.toon))
- Extract shared HTTP fetch/timeout/error patterns from providers.ts and vector-stores.ts ([pm-p0p1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p0p1.toon))
- SDK + extension platform audit and ergonomics ([pm-lvea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lvea.toon))
- Dogfood full E2E lifecycle in temp sandbox ([pm-g4zb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g4zb.toon))
- Performance baseline: list-open reads all 636 items front-matter on every invocation ([pm-f6wr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-f6wr.toon))
- Decision: v2026.5.2 Audit Results - System Healthy ([pm-dmam](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-dmam.toon))
- Dogfood lifecycle matrix in temp project ([pm-cu50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cu50.toon))
- Search + Calendar + SDK deep validation ([pm-937o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-937o.toon))
- main.ts exceeds 5000+ lines - assess decomposition into per-command registration modules ([pm-6c3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6c3h.toon))
- Search/vector/auto-indexing deep audit (critical path) ([pm-4u2e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4u2e.toon))
- CI/CD + telemetry/Sentry client re-audit ([pm-44hv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-44hv.toon))
- Live remote infra + Sentry SaaS analysis ([pm-2o82](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2o82.toon))
- CI/CD hardening sweep - workflows + release scripts ([pm-0kd4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0kd4.toon))

## 2026.5.2 - 2026-05-02

### Added

- SDK: Export ItemFrontMatter and ItemDocument types ([pm-slul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-slul.toon))
- Agent-optimized documentation structure ([pm-r9gu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-r9gu.toon))
- Feature: Core commands verified - all 10 types and lifecycle ([pm-qwe2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qwe2.toon))
- Feature: Extensibility architecture verified - governance, custom types, agent UX ([pm-oe33](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oe33.toon))
- Add --compact mode to pm activity for agent-friendly condensed output ([pm-ne67](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ne67.toon))
- Add vector dimension mismatch warning counter to LanceDB queries ([pm-k213](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k213.toon))
- Performance: Parallelize listAllFrontMatter I/O ([pm-hiji](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hiji.toon))
- Architecture: Decompose extension loader types ([pm-f9s0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f9s0.toon))
- Performance: list/filter operations scan all 625+ item files on each invocation ([pm-cd2f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cd2f.toon))
- Feature: SDK exports complete with 78 public symbols ([pm-92s0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-92s0.toon))
- Docs: Add practical SDK extension examples ([pm-7k9o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7k9o.toon))
- Code Quality: Extract shared primitives module ([pm-5na9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5na9.toon))
- Feature: Calendar fully functional with recurrence expansion ([pm-409c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-409c.toon))
- Audit latest CLI, SDK, calendar, and telemetry workflows ([pm-3fti](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3fti.toon))
- Agent UX: Add --brief output mode and context suggestions ([pm-32si](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-32si.toon))
- Feature: Telemetry pipeline verified end-to-end ([pm-0kjv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0kjv.toon))

### Fixed

- pm cal --include events\|scheduled expands recurring events without default cap ([pm-vg5h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vg5h.toon))
- pm health ok:false for normal telemetry queue draining is non-actionable noise ([pm-gmnh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gmnh.toon))
- Calendar recurring event line has redundant double-title (item title repeated in event title field) ([pm-b1pd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b1pd.toon))
- Telemetry queue timeout: 21 events stuck with flush timeout ([pm-sgmb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sgmb.toon))
- Telemetry: Fix queue bloat and move flush to background ([pm-sgko](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-sgko.toon))
- SDK: bundled extensions use internal imports instead of @unbrained/pm-cli/sdk ([pm-qfuq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qfuq.toon))
- Telemetry queue oversized-event pruning not applied during flush phase (regression) ([pm-on3q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-on3q.toon))
- Issue: Telemetry queue bloat from oversized result_summary payloads ([pm-ntr0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ntr0.toon))
- Calendar --include scheduled alias missing (calendar summary uses 'scheduled' but filter requires 'events') ([pm-itb0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-itb0.toon))
- Search: Fix cosine similarity with L2 normalization ([pm-h2pi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-h2pi.toon))
- Project tracker validation hygiene warnings remain ([pm-e0b5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-e0b5.toon))
- pm templates bare command shows empty output (should list templates) ([pm-dc2y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dc2y.toon))
- pm files --add bare path fails with misleading error (scope implied required) ([pm-8r2r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8r2r.toon))
- Code duplication: toErrorMessage and toNonEmptyString across 5+ files ([pm-540l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-540l.toon))
- Priority --priority error message missing 0..4 range and semantic labels ([pm-1h7w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1h7w.toon))

### Removed

- Remove 15 dead root-level facade re-export files ([pm-l9j6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l9j6.toon))

### Security

- Documentation overhaul and public docs safety ([pm-3042](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-3042.toon))
- 2026-05-02 Full PM CLI Audit: Build Fix, Security, Performance, Telemetry ([pm-nnhi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-nnhi.toon))
- 2026-05-02 Full PM CLI Audit Phase 2: Dead Code Removal, Security Enhancement, Sentry Optimization ([pm-kkmo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-kkmo.toon))
- Chore: 2026-05-02 Phase 3 Audit - IP scrub, dogfood, analysis tooling ([pm-2326](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2326.toon))
- Pin release dependency ranges for Dependabot hygiene ([pm-q71q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-q71q.toon))
- Enhance check-secrets.mjs with private IP detection rule ([pm-daft](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-daft.toon))
- Rewrite README and public documentation ([pm-1sb2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1sb2.toon))

### Other

- Verify remote telemetry stack receives events and data flows to \[redacted_monitoring_ui\] ([pm-g8gj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g8gj.toon))
- 2026-05-01 Full PM CLI Audit Implementation ([pm-twpc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-twpc.toon))
- 2026-05-02 Comprehensive PM CLI Audit ([pm-rrjv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-rrjv.toon))
- 2026-05-01 Full PM CLI Dogfood Audit v2 ([pm-2eb3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-2eb3.toon))
- 2026-04-30 Full PM CLI Dogfood Audit ([pm-23me](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-23me.toon))
- 2026-05-02 Full Audit: All Systems Verified ([pm-ss8d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ss8d.toon))
- Lower Sentry tracesSampleRate from 1.0 to 0.2 for free plan quota ([pm-wvhs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wvhs.toon))
- Chore: Prune stuck telemetry queue entries ([pm-wrbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wrbo.toon))
- Decision: Cap telemetry result_summary payload size ([pm-q9yt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-q9yt.toon))
- Sentry CLI token needs broader scopes for issue analysis ([pm-q4jp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q4jp.toon))
- Dead code: root-level facade re-export shims unused ([pm-nr8k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-nr8k.toon))
- Decision: 2026-05-02 Comprehensive Audit Results ([pm-mve5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-mve5.toon))
- Telemetry: Backfill legacy source_context ([pm-dqer](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dqer.toon))
- Telemetry: Create Grafana dashboard ([pm-6js7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6js7.toon))
- Release @unbrained/pm-cli 2026.5.2 ([pm-5jw8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5jw8.toon))
- Docs: Create telemetry stack runbook ([pm-2lbp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2lbp.toon))

## 2026.5.1-2 - 2026-05-01

### Fixed

- Stabilize post-release cross-platform CI tests ([pm-7d3m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7d3m.toon))

### Other

- Release @unbrained/pm-cli after 2026.3.12 ([pm-x6ni](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-x6ni.toon))

## 2026.5.1 - 2026-05-01

### Added

- Harden entry and add input resilience ([pm-nhgt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-nhgt.toon))
- Governance sweep 2026-04-03 net-new remediation ([pm-r7t2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-r7t2.toon))
- List command large-output ergonomics ([pm-a4z3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-a4z3.toon))
- Activate semantic defaults via local Ollama runtime detection ([pm-zvn2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zvn2.toon))
- Full registration runtime wiring ([pm-zd6y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zd6y.toon))
- Add test-result tracking settings and config policy ([pm-z9k7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z9k7.toon))
- Automatic migration and legacy format gate ([pm-z8bl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-z8bl.toon))
- Add create/update reminder flags and mutation paths ([pm-ysgr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ysgr.toon))
- Add include-body support across list variants ([pm-ykib](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ykib.toon))
- Add TOON migration tests docs and verification ([pm-ybpq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ybpq.toon))
- Narrow contracts --command output by default and add projection modes ([pm-xlzl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xlzl.toon))
- Add dependency visualization command (pm deps) ([pm-x85o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-x85o.toon))
- Configurable item type registry (settings + extensions) ([pm-x2k0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-x2k0.toon))
- Strict skipped-test policy and linked-test assertion semantics ([pm-wtq6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-wtq6.toon))
- Feature: claim takeover on non-terminal items ([pm-w9w4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-w9w4.toon))
- Add governance normalize command with dry-run and apply modes ([pm-vi2v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vi2v.toon))
- List parent filtering and get recovery guidance ([pm-v7o7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v7o7.toon))
- Add notes and learnings command parity ([pm-v1s1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v1s1.toon))
- Command integration tests and docs for TOON storage ([pm-u919](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u919.toon))
- Calendar command with markdown default and multi-view rendering ([pm-tuhf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tuhf.toon))
- Compatibility docs and verification hardening ([pm-tob5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tob5.toon))
- Command-Aware Human Output Redesign ([pm-t2hj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-t2hj.toon))
- Remove none token semantics across command surfaces ([pm-rl4e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rl4e.toon))
- Phase 2 docs, migration guidance, and release verification ([pm-r9nf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-r9nf.toon))
- Phase 2 pluggable core service kernel ([pm-qlo0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qlo0.toon))
- Feature: SDK & Extension System Audit - Comprehensive ([pm-qdha](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qdha.toon))
- Search UX and projection controls ([pm-qb71](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qb71.toon))
- Stdin and PTY fail-safe behavior ([pm-olxl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-olxl.toon))
- SDK publishing and stability contract ([pm-oga6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oga6.toon))
- Add AGENTS rule to check existing pm items before creating new ones ([pm-o5uw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-o5uw.toon))
- Add files discovery subcommand for referenced paths ([pm-n2ts](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-n2ts.toon))
- Feature: update close_reason lifecycle integrity ([pm-m4vu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m4vu.toon))
- Implement deterministic guard for ambiguous create log seeds ([pm-m3mf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m3mf.toon))
- Add governance batch-mutation mode with explicit ownership override planning ([pm-lwps](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-lwps.toon))
- Implement flexible deadline/date parser behavior ([pm-lau3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-lau3.toon))
- Config key discovery and export actions ([pm-kslz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kslz.toon))
- Implement missing-history stream policy and restore fallback ([pm-kb21](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kb21.toon))
- Phase 2 parser and command-contract override engine ([pm-k1zw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-k1zw.toon))
- Implement governance query controls from 2026-04-06 issue report ([pm-jqgc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jqgc.toon))
- Feature: Telemetry Pipeline Audit - Fully Operational ([pm-jkip](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jkip.toon))
- Issue1: validate check-files full tracked scan mode ([pm-j371](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j371.toon))
- Help System Redesign Across All Commands ([pm-j162](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j162.toon))
- Implement context command runtime and surfaces ([pm-iyqf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-iyqf.toon))
- Add dependency-cycle diagnostics to pm validate lifecycle checks ([pm-i4ef](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i4ef.toon))
- Docs, Contracts, and Verification Hardening ([pm-i0iy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i0iy.toon))
- Add option-policy schema and registry resolution ([pm-gu1m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gu1m.toon))
- Validation command and close-time metadata checks ([pm-gtdx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gtdx.toon))
- Implement managed extension state and lifecycle health surfaces ([pm-grst](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-grst.toon))
- Dedicated extension doctor diagnostics surface ([pm-gm9y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gm9y.toon))
- Support pm update body end-to-end ([pm-ghha](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ghha.toon))
- Structured Error Guidance and Diagnostics ([pm-frk8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-frk8.toon))
- Add event and recurrence schema normalization ([pm-f0v0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f0v0.toon))
- Add calendar --full-period option and clarify period boundary wording ([pm-euh6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-euh6.toon))
- Add create/update event and recurrence mutation flags ([pm-enar](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-enar.toon))
- Background test service parity and release verification ([pm-elsh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-elsh.toon))
- Issue2 Feature: Run-level env controls and shared-host-safe flags ([pm-ec5o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ec5o.toon))
- Flexible parser and stdin ingestion foundation ([pm-e7fd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e7fd.toon))
- Add files/docs repeated-add regressions and update flag guidance ([pm-e0ab](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e0ab.toon))
- Extend pm validate with low-signal metadata quality checks ([pm-dw5s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dw5s.toon))
- Implement agent-first help/schema/error surfaces ([pm-dqqa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dqqa.toon))
- External follow-up: add focused extension diagnostics triage summaries ([pm-doek](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-doek.toon))
- Issue2 Feature: Per-linked-test env directives ([pm-dlvv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dlvv.toon))
- Analyze persisted telemetry and add remote analysis skill ([pm-cakn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cakn.toon))
- Persistent reminder item fields and CLI mutation support ([pm-c877](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-c877.toon))
- Linked-test sandbox project/global extension parity ([pm-bkvx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bkvx.toon))
- Background linked-test orchestration and run management ([pm-bi0z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bi0z.toon))
- Expand aggregate group-by to support priority, status, assignee, tags ([pm-bhhe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bhhe.toon))
- Issue3 Feature: Extract PM-id references from linked commands ([pm-bf54](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bf54.toon))
- Required-option guidance and docs parity ([pm-b3id](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-b3id.toon))
- Bulk comments audit query surface ([pm-ayyt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ayyt.toon))
- Exit/output and subprocess runtime hardening ([pm-axlr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-axlr.toon))
- Stability regressions and update/file UX guidance hardening ([pm-ap8l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ap8l.toon))
- Core command-dispatch override engine ([pm-al0h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-al0h.toon))
- Issue5: comments audit append policy path ([pm-ahq1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ahq1.toon))
- Extend SDK contracts and Pi wrapper for extension lifecycle actions ([pm-9ajy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9ajy.toon))
- Phase 2 preflight and lifecycle interception engine ([pm-977j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-977j.toon))
- Add history missing-stream policy setting and config support ([pm-8wnm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8wnm.toon))
- Clarify ownership conflict guidance for force overrides ([pm-8sgf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8sgf.toon))
- Calendar occurrence engine and advanced view filtering ([pm-8m6s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8m6s.toon))
- Add advanced event filters and bounded recurrence controls ([pm-8kxm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8kxm.toon))
- Linked-test PM context parity controls and mismatch guardrails ([pm-8izv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8izv.toon))
- Sunset pm install command and migrate to extension manager installs ([pm-8a2s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8a2s.toon))
- Feature: comments force guidance parity ([pm-7y8q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7y8q.toon))
- Health history drift detection ([pm-7vr9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7vr9.toon))
- Automate duplicate-cluster detection and canonical mapping report ([pm-7lum](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7lum.toon))
- Feature: Core Commands Audit - All Passing ([pm-7kiy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7kiy.toon))
- Feature: Calendar Subsystem Audit - All Passing ([pm-7k60](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7k60.toon))
- Implement pm extension lifecycle command surface ([pm-7ghv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7ghv.toon))
- Add reusable item templates for pm create ([pm-780f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-780f.toon))
- Add lazy dynamic tag completion with optional eager expansion ([pm-6qnu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6qnu.toon))
- Issue3: files add stable append diff mode ([pm-6jps](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6jps.toon))
- Add tests and completion coverage for include-body list flag ([pm-6e0p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6e0p.toon))
- Implement CLI telemetry consent and runtime pipeline ([pm-5v5w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5v5w.toon))
- Add extension adopt workflow for unmanaged extensions ([pm-5dia](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5dia.toon))
- Dual-format item codec and storage support ([pm-5cbm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5cbm.toon))
- Policy-driven option controls for create/update ([pm-5bwo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5bwo.toon))
- Wave 8/9: add test-all limit/offset blast-radius controls ([pm-5a4f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5a4f.toon))
- Extension help and contracts runtime introspection ([pm-4bhw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4bhw.toon))
- Enforce command-required linked tests at mutation time ([pm-44iu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-44iu.toon))
- Issue4: create strict vs progressive policy mode ([pm-431e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-431e.toon))
- Add glob-based linked artifact additions for files/docs ([pm-3eu2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3eu2.toon))
- Health vectorization status and targeted refresh ([pm-3ebr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3ebr.toon))
- Add extension registration support for custom item types/options ([pm-37pj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-37pj.toon))
- Implement extension source resolver and installer engine ([pm-2poj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2poj.toon))
- Extended schema fields v1.1 - parent, reviewer, risk, sprint, release ([pm-2p6q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2p6q.toon))
- Health optional directory strictness and compatibility ([pm-2i0i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2i0i.toon))
- 2026-04-25 full dogfood audit remediation wave ([pm-2hrt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2hrt.toon))
- Dynamic type integration across CLI, storage, and completion ([pm-277p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-277p.toon))
- Canonical status alias normalization across CLI surfaces ([pm-1r6p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1r6p.toon))
- Configurable test-result tracking on PM items ([pm-16f4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-16f4.toon))
- Agent integration and docs hardening for calendar/reminders ([pm-122q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-122q.toon))
- Phase 2 SDK v2 contracts with backward-compat adapters ([pm-0u1y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0u1y.toon))
- Add activity filtering and stream mode for large program automation ([pm-0g7a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0g7a.toon))
- Event and recurrence schema with mutation contracts ([pm-0ab3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0ab3.toon))
- Calendar parity integrations and release hardening ([pm-02gd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-02gd.toon))

### Changed

- Add scoped audit override mode for pm update metadata mutations ([pm-umhv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-umhv.toon))
- Update-many: improve error message when no mutation flags provided ([pm-twtu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-twtu.toon))
- Update body backfill normalization parity ([pm-ihfm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-ihfm.toon))
- Parser update: support +m and flexible date strings ([pm-y8a8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-y8a8.toon))
- Implement atomic dependency replacement mode for pm update ([pm-tixl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tixl.toon))
- Improve update-command close and audit-owner failure guidance from telemetry ([pm-syt7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-syt7.toon))
- Update completion and Pi wrapper for calendar/reminder support ([pm-qze9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qze9.toon))
- T5: Update docs for terminal compatibility guarantees ([pm-qkva](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qkva.toon))
- Update docs and release evidence for default Ollama semantic behavior ([pm-ptu0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ptu0.toon))
- Update docs and verify status alias release readiness ([pm-posc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-posc.toon))
- Implement pm update-many with dry-run checkpoints and rollback ([pm-lf6s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lf6s.toon))
- Document update body support and ship verification evidence ([pm-ipm8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ipm8.toon))
- Align update body contracts completion and regressions ([pm-ha5a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ha5a.toon))
- Task: implement update close_reason flag and reopen auto-clear ([pm-g8jp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g8jp.toon))
- Wire update body runtime mutation path ([pm-eszd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eszd.toon))
- Error2: Refactor commander usage mapping and dedupe error output ([pm-eonv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eonv.toon))
- Update linked-test regressions docs and verification evidence ([pm-dk0a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dk0a.toon))
- Implement explicit clear/unassigned semantics and remove none token behavior ([pm-d7id](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-d7id.toon))
- Enforce option policies in create/update and help errors ([pm-co62](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-co62.toon))
- Improve required option error/help guidance with examples ([pm-bzyr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bzyr.toon))
- C3: Update docs and release notes for comments UX ([pm-bx5r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bx5r.toon))
- Add deterministic linked-test replacement mode for update test mutations ([pm-bjpo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bjpo.toon))
- Update docs and changelog for six audit findings ([pm-9eaz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-9eaz.toon))
- Update completion and Pi wrapper for event recurrence flags ([pm-5hbj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5hbj.toon))
- Phase 2: update extension architecture and migration docs ([pm-4epk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4epk.toon))
- Align update-many status mutation support with help/contracts ([pm-3cx8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3cx8.toon))
- Update docs and finalize calendar/reminder release changes ([pm-2v01](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2v01.toon))
- Publish governance refactor report (2026-04-04) ([pm-2r70](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2r70.toon))
- T2: Refactor CLI error exits to graceful exitCode flow ([pm-1119](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1119.toon))

### Fixed

- Add opt-in runtime probe mode for extension manage parity ([pm-p0ij](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p0ij.toon))
- Templates command: document correct invocation syntax (positional vs --name) ([pm-6y6i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6y6i.toon))
- Validate UUID fields at telemetry ingestion boundary ([pm-vhdc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vhdc.toon))
- Fix Grafana RabbitMQ queue panel metric selector mismatch ([pm-r9ei](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r9ei.toon))
- Implement local telemetry queue retention_days TTL cleanup ([pm-pxx0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pxx0.toon))
- Add pm version and source classification to telemetry payloads ([pm-3dd9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3dd9.toon))
- Add dependency mutation command for existing items ([pm-zdec](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zdec.toon))
- Auto-migrate previous-version trackers on first mutation ([pm-yvwt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yvwt.toon))
- Cross-command regression verification for date parsing expansion ([pm-x6l7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x6l7.toon))
- Add extension project scaffold command or template ([pm-wsui](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wsui.toon))
- Allow unquoted multi-word search queries ([pm-v6ob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v6ob.toon))
- Expand regression and release-readiness tests for calendar/reminders ([pm-tyq3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tyq3.toon))
- Terminal compatibility regression suite and docs parity ([pm-t6f7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-t6f7.toon))
- Fix cross-platform CI regressions surfaced by GitHub checks ([pm-skyg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-skyg.toon))
- Document resilient input formats and lock regression coverage ([pm-s9hl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-s9hl.toon))
- Ship regression tests docs and verification evidence ([pm-r9dy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r9dy.toon))
- Regression and release hardening ([pm-qwp7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qwp7.toon))
- Fix LanceDB vector dimension mismatch blocking default search ([pm-oyt8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oyt8.toon))
- Replace invalid-id echo in get not-found guidance ([pm-opbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-opbo.toon))
- Add compact/full/fields search output controls with compact default ([pm-nrxm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nrxm.toon))
- Include active extension commands/actions in contracts output ([pm-nnfc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nnfc.toon))
- SDK starter example leaves extension health warning ([pm-mwiz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mwiz.toon))
- Align default item types with Decision tracking guidance ([pm-mpmv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mpmv.toon))
- Fix validate --check-files false-positive on linked project paths ([pm-m9tv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m9tv.toon))
- Clarify strict create empty repeatable semantics ([pm-k8i0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-k8i0.toon))
- C2: Add comments shorthand regression coverage ([pm-k0mr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k0mr.toon))
- Test1: Expand regression coverage for help/error/output UX ([pm-jfpf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jfpf.toon))
- Fix integration test: health check list missing telemetry entry ([pm-hb6x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hb6x.toon))
- Remove TOON front_matter wrapper from item files ([pm-h3tp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h3tp.toon))
- Enforce telemetry capture_level setting in runtime event collection ([pm-gusd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gusd.toon))
- T4: Add terminal compatibility regression coverage ([pm-gh7d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gh7d.toon))
- Reject undefined placeholder IDs in parent/dependency inputs ([pm-g9yi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g9yi.toon))
- Expose extension command schema details in runtime help ([pm-ek2h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ek2h.toon))
- Align templates-save Pi contracts with supported CLI flags ([pm-eg0a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eg0a.toon))
- Fix pm test run exit semantics for failed linked tests ([pm-c1bn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c1bn.toon))
- Strengthen SDK typing for extension registration contracts ([pm-bqg4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bqg4.toon))
- Investigate search command latency from persisted telemetry ([pm-bhmu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bhmu.toon))
- Add regression coverage for Ollama-backed semantic defaults ([pm-9k33](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9k33.toon))
- Calendar: allow --full-period for agenda view or improve error message ([pm-8qpc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8qpc.toon))
- Fix parser overrides for core commands without positional args ([pm-7jkm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7jkm.toon))
- Linked-test PM command context can drift from workspace dataset ([pm-6pij](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6pij.toon))
- Phase 2: parser override regression and docs coverage ([pm-6024](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6024.toon))
- Expand recurrence regression and runtime contract tests ([pm-5xih](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5xih.toon))
- E1: Expand override and no-extension regression matrix ([pm-5chf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5chf.toon))
- Add telemetry runtime diagnostics to pm health ([pm-300m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-300m.toon))
- Clarify or harden SDK import resolution for local extension installs ([pm-1etl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1etl.toon))
- Context blocked-fallback test uses date-sensitive default deadline ([pm-0xhj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0xhj.toon))
- Add status alias regression tests ([pm-0kga](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0kga.toon))
- Add --parent filter support for list and list-\* commands ([pm-08zg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-08zg.toon))

### Removed

- Extend restore to recover missing or deleted item files from history ([pm-g6qd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g6qd.toon))

### Security

- Remediate open GitHub findings and recurring checks ([pm-i7w2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-i7w2.toon))
- Track GitHub Dependabot alert \#26 for undici (GHSA-v9p9-hfj2-hcw8) ([pm-ylg3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ylg3.toon))
- Track GitHub Dependabot alert \#24 for undici (GHSA-2mjp-6q6p-2qxm) ([pm-x4sy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x4sy.toon))
- Track GitHub Dependabot alert \#25 for undici (GHSA-vrm6-8vpv-qv8q) ([pm-s5vv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s5vv.toon))
- Track GitHub Dependabot alert \#27 for undici (GHSA-4992-7rv2-5pvq) ([pm-02c4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-02c4.toon))
- Issue: Private IP address in committed pm task files ([pm-xk8b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xk8b.toon))
- Track GitHub Dependabot alert \#8 for undici (GHSA-wqq4-5wpv-mx2g) ([pm-v6vi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v6vi.toon))
- Track GitHub Dependabot alert \#11 for undici (GHSA-9qxr-qj54-h672) ([pm-tl4d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tl4d.toon))
- Track GitHub Dependabot alert \#19 for undici (GHSA-f269-vfmq-vjvj) ([pm-rb9v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rb9v.toon))
- Ignore local .env files for telemetry/security operations ([pm-qgvj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qgvj.toon))
- Track GitHub Dependabot alert \#12 for undici (GHSA-cxrh-j4jr-qwg3) ([pm-pagj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pagj.toon))
- Track GitHub Dependabot alert \#5 for fast-json-patch (GHSA-8gh8-hqwg-xf34) ([pm-pacx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pacx.toon))
- Track GitHub Dependabot alert \#1 for undici (GHSA-3cvr-822r-rqcc) ([pm-ncbe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ncbe.toon))
- Track GitHub Dependabot alert \#10 for undici (GHSA-m4v8-wqvr-p9f7) ([pm-ipul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ipul.toon))
- Track GitHub Dependabot alert \#22 for undici (GHSA-vrm6-8vpv-qv8q) ([pm-i1rm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i1rm.toon))
- Track GitHub Dependabot alert \#4 for undici (GHSA-f772-66g8-q5h3) ([pm-eu59](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eu59.toon))
- Track GitHub Dependabot alert \#9 for undici (GHSA-3787-6prv-h9w3) ([pm-d3i5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d3i5.toon))
- Track GitHub Dependabot alert \#21 for undici (GHSA-4992-7rv2-5pvq) ([pm-cg7l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cg7l.toon))
- Track GitHub Dependabot alert \#3 for undici (GHSA-8qr4-xgw6-wmr3) ([pm-bv2c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bv2c.toon))
- Track GitHub Dependabot alert \#6 for undici (GHSA-r6ch-mqf9-qc9w) ([pm-8m72](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8m72.toon))
- Track GitHub Dependabot alert \#2 for undici (GHSA-q768-x9m6-m9qp) ([pm-5p3z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5p3z.toon))
- Track GitHub Dependabot alert \#29 for picomatch (GHSA-3v7f-55p6-f55p) ([pm-5e88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5e88.toon))
- Track GitHub Dependabot alert \#23 for undici (GHSA-v9p9-hfj2-hcw8) ([pm-53q4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-53q4.toon))
- Track GitHub Dependabot alert \#13 for undici (GHSA-g9mf-h72j-4rw9) ([pm-51y8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-51y8.toon))
- Track GitHub Dependabot alert \#7 for zod (GHSA-m95q-7qp3-xv42) ([pm-4ydh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4ydh.toon))
- D2: Update compatibility and security/trust guidance ([pm-3949](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3949.toon))
- Documentation, migration, and safety posture ([pm-31fj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-31fj.toon))
- Track GitHub Dependabot alert \#18 for undici (GHSA-2mjp-6q6p-2qxm) ([pm-10no](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-10no.toon))
- Track GitHub Dependabot alert \#20 for undici (GHSA-phc3-fgpg-7m6h) ([pm-090w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-090w.toon))

### Other

- 2026-04-26 Comprehensive PM CLI Dogfood Audit - Full Results ([pm-z87r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-z87r.toon))
- Run weekly GitHub findings review ([pm-lou4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lou4.toon))
- Core commands audit: full CRUD lifecycle verified with all item types ([pm-ewxk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ewxk.toon))
- Extension system audit: install/manage/doctor/activate lifecycle fully working ([pm-3s52](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3s52.toon))
- Implement search argument and projection mode changes ([pm-0nxf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0nxf.toon))
- Health drift and vectorization integrity ([pm-1hkq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-1hkq.toon))
- TOON item storage migration ([pm-bckz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-bckz.toon))
- History stream resilience and restore recovery hardening ([pm-ofh9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-ofh9.toon))
- Agent-optimized calendar and reminders ([pm-qh3p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-qh3p.toon))
- Calendar parity phase 2: events and recurrence ([pm-vdrn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-vdrn.toon))
- Configurable item types and required-option UX ([pm-r15d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-r15d.toon))
- Auto-enable semantic search when local Ollama is available ([pm-67uh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-67uh.toon))
- Agent context command ( / ) ([pm-abhj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-abhj.toon))
- Linked-test parity and runnable command enforcement ([pm-mf5z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-mf5z.toon))
- Background linked-test service and item result tracking ([pm-lm0j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-lm0j.toon))
- Extension lifecycle manager and SDK parity rollout ([pm-m9jc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-m9jc.toon))
- Full Override SDK + Extensions Platform ([pm-x395](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-x395.toon))
- Universal terminal compatibility hardening ([pm-mudv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-mudv.toon))
- Deadline/date parsing compatibility hardening ([pm-va6e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-va6e.toon))
- Status alias compatibility hardening ([pm-g6a2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-g6a2.toon))
- Configurable option policies for core commands ([pm-00yy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-00yy.toon))
- List JSON Body Projection Contract ([pm-0lbm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-0lbm.toon))
- Agent-friendly comments command UX hardening ([pm-v3g3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-v3g3.toon))
- Agent-First CLI UX v3 follow-up ([pm-pfn8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-pfn8.toon))
- CLI UX and Integrity Hardening ([pm-hp31](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-hp31.toon))
- CLI UX Overhaul: Help, Errors, and Output ([pm-izbd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-izbd.toon))
- Issue2: Shared-host linked-test determinism ([pm-9dp3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-9dp3.toon))
- Issue3: Validate stale PM-id command references ([pm-br88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-br88.toon))
- External audit Issue1 follow-up: log-seed ambiguity guard ([pm-pb0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-pb0g.toon))
- External audit follow-up: linked-test evidence and extension diagnostics ([pm-5z9r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-5z9r.toon))
- External audit follow-up: validation and large-output ergonomics ([pm-qfg8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-qfg8.toon))
- External audit follow-up: unresolved UX and dependency visualization gaps ([pm-iswo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-iswo.toon))
- External audit issue remediation and compatibility hardening ([pm-my6o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-my6o.toon))
- External issue report remediation 2026-04-05 ([pm-gt8u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-gt8u.toon))
- Telemetry and observability rollout ([pm-lnq3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-lnq3.toon))
- PM CLI governance and documentation overhaul ([pm-wtsp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-wtsp.toon))
- Continuous governance automation and policy enforcement ([pm-5rjn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-5rjn.toon))
- Epic: 2026-04-28 Full PM CLI Dogfood Audit ([pm-wg1d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-wg1d.toon))
- PM CLI 2026-04-06 audit findings remediation ([pm-o7be](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-o7be.toon))
- Execute telemetry + observability rollout implementation ([pm-ny6y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ny6y.toon))
- 2026-04-26 comprehensive dogfood audit stabilization ([pm-mb4n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mb4n.toon))
- Backfill telemetry documentation files referenced in tracker links ([pm-35wb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-35wb.toon))
- Track open Dependabot PR \#14 ([pm-0jpx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0jpx.toon))
- Make lifecycle validate patterns configurable ([pm-urxb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-urxb.toon))
- Differentiate pm list (active-only) from pm list-all (all items) ([pm-zzt1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zzt1.toon))
- Document and verify health drift/vectorization changes ([pm-yo5m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yo5m.toon))
- External audit follow-up docs sync and verification gate ([pm-ykgu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ykgu.toon))
- Ship1: Full verification, closure evidence, commit, and push ([pm-y76e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-y76e.toon))
- Implement Issue3 files stable-append mutation mode ([pm-xv39](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xv39.toon))
- GC safety ergonomics: dry-run and scoped cleanup ([pm-xrm7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xrm7.toon))
- Governance standards alignment follow-up 2026-04-04 ([pm-xjf9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xjf9.toon))
- Generate shell completion flags from command contracts ([pm-xhot](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xhot.toon))
- Output1: Implement command-aware non-JSON result summaries ([pm-x3fh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x3fh.toon))
- Implement health history drift diagnostics ([pm-x0vj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x0vj.toon))
- Issue3 Task: Contracts Pi docs and tests parity ([pm-wvr0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wvr0.toon))
- Implement Ollama-aware semantic default resolution in runtime ([pm-wn3r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wn3r.toon))
- Enforce command-required linked test mutations ([pm-wn34](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wn34.toon))
- Implement comments-audit command with filters/latest ([pm-w1j3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-w1j3.toon))
- Implement include-body retrieval in list command pipeline ([pm-vsux](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vsux.toon))
- Implement PM-context parity mode and mismatch metadata for linked tests ([pm-vrsn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vrsn.toon))
- Help1: Centralize help composer and command narratives ([pm-vf7n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vf7n.toon))
- Implement Issue4 create progressive policy mode ([pm-v7aw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-v7aw.toon))
- Implement health vectorization targeted refresh ([pm-v48k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-v48k.toon))
- Decision: PM CLI audit confirms production readiness ([pm-unbq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-unbq.toon))
- Track open Dependabot PR \#9 ([pm-u4hy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-u4hy.toon))
- Document recurrence features and finalize release evidence ([pm-tytr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tytr.toon))
- B3: Executable extension migration lifecycle ([pm-twpm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-twpm.toon))
- Sync docs/contracts/wrapper parity for unresolved external audit additions ([pm-tcx8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tcx8.toon))
- Implement health optional-directory defaults and strict mode ([pm-t7xl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t7xl.toon))
- A2: Core override precedence and collision diagnostics ([pm-t6xf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t6xf.toon))
- B1: Wire registerItemFields into runtime validation ([pm-t0yd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t0yd.toon))
- Implement extension help and contracts runtime integration ([pm-sucq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sucq.toon))
- Phase 2: implement extension preflight override pipeline ([pm-sh14](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sh14.toon))
- Implement automatic migration and mutation gate ([pm-s0ne](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-s0ne.toon))
- Support type-aware storage routing and safe type moves ([pm-rv63](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rv63.toon))
- E2: Final verification and closure evidence ([pm-rl7j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rl7j.toon))
- T6: Run full verification, close items, and ship ([pm-r4t0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r4t0.toon))
- Drive repository coverage gate back to 100 percent ([pm-r28k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r28k.toon))
- Implement sandbox seeding for project/global extension parity ([pm-qtvv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qtvv.toon))
- SDK docs: document cli-contracts exports and extension capability requirements ([pm-qrxb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qrxb.toon))
- M5 follow-up: validate extension registration handler types ([pm-qkx0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qkx0.toon))
- Docs1: Refresh README/PRD/architecture/extensions/changelog ([pm-qhcw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qhcw.toon))
- Implement centralized status alias normalization ([pm-ptal](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ptal.toon))
- M4: Keyword indexing and search command ([pm-pmd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pmd.toon))
- M2: RFC6902 patch generation per mutation ([pm-p9z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p9z.toon))
- Follow-up: expand built-in item types for calendar-native work ([pm-p5q3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p5q3.toon))
- A3: Hook context parity and lifecycle symmetry ([pm-osk5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-osk5.toon))
- Implement background start paths and test-runs command surface ([pm-ormq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ormq.toon))
- Implement dual-format codec and store lookup ([pm-oex4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oex4.toon))
- M5: Built-in beads import extension ([pm-odt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-odt.toon))
- Consolidate 2026-04-25 dogfood audit evidence and tracker links ([pm-odcr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-odcr.toon))
- Phase 2: compatibility adapters and migration diagnostics ([pm-ngdf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ngdf.toon))
- Phase 2: wire parser override contracts in runtime ([pm-nfii](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nfii.toon))
- Track open Dependabot PR \#7 ([pm-n8w4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-n8w4.toon))
- Wave 8/9: restore replay patch compatibility and diagnostics ([pm-n5cw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-n5cw.toon))
- Release @unbrained/pm-cli 2026.3.12 ([pm-lz4m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-lz4m.toon))
- Implement tolerant entry parser and stdin token utility ([pm-luay](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-luay.toon))
- Phase 2: integrate service overrides into core modules ([pm-leol](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-leol.toon))
- Code/test/docs for create log-seed ambiguity guard ([pm-l5tr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l5tr.toon))
- C1: Publish explicit extension SDK exports ([pm-l16r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l16r.toon))
- Implement Issue1 validate scan-mode and candidate totals ([pm-kshe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kshe.toon))
- Follow-up: enhance calendar UX for agents and LLM parsing ([pm-kglq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kglq.toon))
- Implement pm validate and --validate-close behavior ([pm-k6ml](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k6ml.toon))
- Implement list parent filter and get guidance updates ([pm-jlsh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jlsh.toon))
- Phase 2: publish SDK contracts for parser/preflight/services ([pm-j24z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-j24z.toon))
- Run latest-build temp-project dogfood audit and remediate findings ([pm-j16d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-j16d.toon))
- Implement list offset pagination and JSON stream mode ([pm-ice4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ice4.toon))
- Persist bounded test run summaries on item records ([pm-i2pc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i2pc.toon))
- M5 hardening: unknown extension capability diagnostics ([pm-hzh6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hzh6.toon))
- Implement extension doctor summary/deep diagnostics command ([pm-hjrr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hjrr.toon))
- C1: Implement intuitive comments argument parsing ([pm-hcco](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hcco.toon))
- Align extension hook docs with runtime types and SDK surface ([pm-hbtn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hbtn.toon))
- Track extension GitHub shorthand source documentation parity ([pm-h8j3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-h8j3.toon))
- Align extension metadata and completion/wrapper parity ([pm-h2eo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h2eo.toon))
- Build and wire runtime item type registry ([pm-h1no](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h1no.toon))
- Document include-body list contract and capture validation evidence ([pm-gudp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gudp.toon))
- Error1: Introduce structured error model and builders ([pm-gggs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gggs.toon))
- Wave 8/9: clarify get --json body field behavior ([pm-gb25](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gb25.toon))
- T1: Implement stdin and PTY fail-safe behavior ([pm-fas4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fas4.toon))
- Implement and verify pm context command ([pm-f583](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f583.toon))
- Implement calendar command core views and filtering ([pm-ezri](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ezri.toon))
- Track open Dependabot PR \#10 ([pm-eoil](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eoil.toon))
- T3: Harden linked-test subprocess anti-hang behavior ([pm-dzrj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dzrj.toon))
- Retire pm install path semantics with command removal ([pm-cxn3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cxn3.toon))
- Wave 8/9: non-interactive help paging safeguards and --no-pager ([pm-crk9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-crk9.toon))
- Overhaul extension and SDK documentation with install equivalence examples ([pm-cdsf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cdsf.toon))
- Sync docs and contracts for external audit remediation ([pm-c8dz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-c8dz.toon))
- Implement pm notes and pm learnings command stack ([pm-c465](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-c465.toon))
- C2: Backward-safe extension SDK compatibility shims ([pm-bw3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bw3h.toon))
- Harden mutation-triggered vector refresh coverage across write paths ([pm-bgd8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bgd8.toon))
- Execute Agent-First CLI UX v3 implementation ([pm-b21u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b21u.toon))
- Implement fail-on-skipped policy and linked-test assertions ([pm-au2z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-au2z.toon))
- Track open Dependabot PR \#5 ([pm-akty](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-akty.toon))
- Run full verification and release evidence for audit remediation ([pm-ac8x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ac8x.toon))
- Wave 8/9: event parse errors with field-specific attribution ([pm-a3eq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a3eq.toon))
- External follow-up: reduce tracked-all orphaned noise from PM internals ([pm-a228](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a228.toon))
- Generate unknown-command remediation examples from runtime registry ([pm-a01m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a01m.toon))
- Docs/help refresh for expanded deadline/date inputs ([pm-9sg4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9sg4.toon))
- Run background-service release verification and closure evidence ([pm-9ik7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-9ik7.toon))
- Clarify config policy value ergonomics for strict modes ([pm-9ayo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9ayo.toon))
- Implement item_format settings model ([pm-9689](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9689.toon))
- D1: Rewrite extension and architecture docs for full override ([pm-8qne](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8qne.toon))
- 2026-04-26 comprehensive pm CLI dogfood audit ([pm-8pzn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8pzn.toon))
- Task: harden comments force guidance across help/docs/completion ([pm-8k83](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8k83.toon))
- Implement Issue5 comments audit append path ([pm-8k10](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8k10.toon))
- Implement reminder schema validation and deterministic ordering ([pm-7e6n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7e6n.toon))
- Track open Dependabot PR \#6 ([pm-7akk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7akk.toon))
- Phase 2: implement service override contracts and runtime registry ([pm-78jt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-78jt.toon))
- Calendar audit: all views verified working, reminders and deadlines render correctly ([pm-71sj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-71sj.toon))
- Docs, contracts, and verification sweep for external audit follow-up ([pm-64f1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-64f1.toon))
- Phase 2: lifecycle mutation safety and compatibility tests ([pm-5mqd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5mqd.toon))
- Implement config list/export command actions ([pm-5lmj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5lmj.toon))
- Full-repo audit hardening pass (warnings + metadata alignment) ([pm-4vm7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4vm7.toon))
- Implement pm dedupe-audit command modes and merge suggestions ([pm-4n1a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4n1a.toon))
- Sync contracts/completion/Pi for background test-run surfaces ([pm-4moz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4moz.toon))
- M4 follow-up: exact-title lexical boost for deterministic search ranking ([pm-4iga](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4iga.toon))
- Issue2 Task: Structured linked-test failure classification ([pm-4g5i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4g5i.toon))
- External follow-up: suppress EPIPE stack traces in piped output ([pm-4emi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4emi.toon))
- Expose start-task pause-task close-task as first-class CLI aliases ([pm-3www](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3www.toon))
- M5: Built-in todos import export extension ([pm-3s0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3s0.toon))
- Verify extension manager rollout and deliver release evidence ([pm-3gzy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3gzy.toon))
- M1: Item schema model and validation ([pm-3gi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3gi.toon))
- Telemetry pipeline verified: all \[redacted_service_count\] services healthy, E2E event ingestion working ([pm-3akm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3akm.toon))
- Integrate command and extension format behavior ([pm-3aga](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3aga.toon))
- Chore: Telemetry queue steady-state has 100 pending entries ([pm-2gmr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2gmr.toon))
- A1: Unified extension-first command router ([pm-2bxh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2bxh.toon))
- Issue3 Task: Default-on validate command reference check ([pm-2ajr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2ajr.toon))
- Implement shared history-stream policy helper and command enforcement ([pm-1tyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1tyv.toon))
- Phase 2: full verification matrix and closure evidence ([pm-1had](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1had.toon))
- Track open Dependabot PR \#12 ([pm-16pn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-16pn.toon))
- B2: Wire search providers and vector adapters ([pm-14qs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-14qs.toon))
- Finalize tests docs verification and release evidence for history hardening ([pm-0vnr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0vnr.toon))
- Wire resilient entry ingestion across mutation commands ([pm-0pvk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0pvk.toon))
- Implement recurrence occurrence expansion in calendar views ([pm-0c0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0c0g.toon))
- Task: allow claim takeover without force for non-terminal items ([pm-05u4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-05u4.toon))

## 2026.3.12 - 2026-03-13

### Fixed

- Fix Beads Import Lossiness ([pm-axl0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-axl0.toon))

### Security

- Track and commit imported pm issue/history files ([pm-rbdu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rbdu.toon))
- Sanitize publishable worktree before push ([pm-mcli](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mcli.toon))
- Cut public release 2026.3.9 ([pm-1h88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1h88.toon))

### Other

- Maintain release readiness 2026-03-09 (Run 9) ([pm-7vr0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7vr0.toon))
- Maintain release readiness 2026-03-09 (Run 7) ([pm-zre8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zre8.toon))
- Rewrite README for public users ([pm-uc33](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uc33.toon))
- Replace docs-as-contract tests with pm-data/runtime checks ([pm-sevn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sevn.toon))
- Expand README quick start create example to full field surface ([pm-mltd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mltd.toon))
- Maintain release readiness 2026-03-09 (Run 6) ([pm-j0o4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-j0o4.toon))
- Maintain release readiness 2026-03-09 (Run 5) ([pm-6k5l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6k5l.toon))
- Generalize CLI help text for universal positioning ([pm-30zl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-30zl.toon))
- Maintain release readiness 2026-03-09 (Run 8) ([pm-2cr5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2cr5.toon))

## 2026.3.9 - 2026-03-09

### Added

- Add README badges and update CONTRIBUTING.md to reference docs/ ([pm-x4f9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-x4f9.toon))
- Add --title and -t support for pm update ([pm-w1r6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-w1r6.toon))
- Add --ac alias for create acceptance criteria ([pm-vyqe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vyqe.toon))
- Add issue-specific metadata fields to item schema and CLI ([pm-rs40](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rs40.toon))
- Pi wrapper action parity: add completion action ([pm-oqe0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oqe0.toon))
- Add automated npm release workflow and Node 24 CI coverage ([pm-mwe8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mwe8.toon))
- Add snake_case aliases for create/update acceptance and estimate flags ([pm-mfza](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mfza.toon))
- Add confidence metadata flag support for create/update ([pm-kpz5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kpz5.toon))
- Add definition-of-done config baseline ([pm-jdt8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jdt8.toon))
- Add package.json npm metadata and GitHub community files ([pm-ixbk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ixbk.toon))
- M5 roadmap: Pi agent extension advanced ergonomics ([pm-hbc1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hbc1.toon))
- Add integration test for pm list active-only behavior ([pm-gus1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gus1.toon))
- Add list-draft command parity for draft status ([pm-ex1y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ex1y.toon))
- Add Node 25 to nightly CI and create docs/ architecture+extension guides ([pm-aa6w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-aa6w.toon))
- Add med alias for risk flag values ([pm-7w60](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7w60.toon))
- Add pm completion command for bash/zsh/fish shell completion ([pm-7hx6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7hx6.toon))
- Add --ac alias parity for pm update acceptance criteria ([pm-3qrp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3qrp.toon))
- Repo restructure and module boundaries ([pm-2c8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2c8.toon))

### Changed

- Release readiness refactor ([pm-ote](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-ote.toon))
- Installer scripts and update path ([pm-tq1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tq1.toon))
- Promote strategic metadata flags into canonical create/update contract ([pm-phob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-phob.toon))
- Release-readiness guard for update help/contract parity ([pm-cujj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cujj.toon))
- Pi wrapper all-fields create/update parity ([pm-096j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-096j.toon))
- M1: Core command set init create get update append delete claim release close ([pm-06t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-06t.toon))

### Fixed

- Release-readiness contract audit and next fix (2026-03-06 run) ([pm-qkj9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-qkj9.toon))
- Release-readiness contract audit and next fix (2026-03-06 run 5) ([pm-x89f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-x89f.toon))
- Deduplicate test-all linked test execution across items ([pm-v6e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v6e.toon))
- Release readiness contract audit and next fix ([pm-oadl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-oadl.toon))
- Release-readiness contract audit and next fix (2026-03-06 run 3) ([pm-eamp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eamp.toon))
- Fix sandbox runner passthrough for targeted test commands ([pm-2rl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2rl.toon))
- Release-readiness contract audit and next fix (2026-03-06 run 4) ([pm-2joy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2joy.toon))

### Removed

- M4 follow-up: remove deleted items from semantic vector indexes ([pm-fdla](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fdla.toon))
- Remove session-based ownership model ([pm-5rh2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5rh2.toon))
- Implement pm delete command ([pm-4yl0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4yl0.toon))

### Security

- Fix devDependency security vulnerabilities via c8 and rollup updates ([pm-r3fi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r3fi.toon))
- Harden include-linked path containment ([pm-q35x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-q35x.toon))
- Add npm provenance attestation to release workflow ([pm-mwap](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mwap.toon))
- Harden include-linked symlink containment ([pm-lxa0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lxa0.toon))
- M5: Enforce symlink-resolved extension entry boundary ([pm-fsyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fsyv.toon))
- Release hardening: scoped npm + version policy + CI ([pm-1hm2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1hm2.toon))

### Other

- Milestone 6 - Hardening + Release Readiness ([pm-jiw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-jiw.toon))
- Milestone 5 - Extension System + Built-ins ([pm-b1w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-b1w.toon))
- Milestone 4 - Search ([pm-f45](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-f45.toon))
- Milestone 3 - Query + Operations ([pm-54d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-54d.toon))
- Milestone 2 - History + Restore ([pm-c0r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-c0r.toon))
- Milestone 1 - Core Item CRUD + Locking ([pm-u9r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-u9r.toon))
- Milestone 0 - Foundations ([pm-2xl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-2xl.toon))
- Build pm-cli v1 ([pm-j7a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-j7a.toon))
- Release-readiness maintenance loop 2026-03-08 run 1 ([pm-vz16](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vz16.toon))
- Release-readiness maintenance loop 2026-03-07 run 2 ([pm-phpq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-phpq.toon))
- Preserve confidence in todos import mapping ([pm-zoyg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zoyg.toon))
- M4: Mutation-triggered search cache invalidation ([pm-zgkk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zgkk.toon))
- M3: stats health and gc commands ([pm-zau](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zau.toon))
- M4: Embedding provider abstraction ([pm-yv2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yv2.toon))
- M5 follow-up: activity history directory read hook dispatch ([pm-xyv3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xyv3.toon))
- CI workflows and quality gates ([pm-wo8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wo8.toon))
- Release-readiness maintenance loop 2026-03-07 run 7 ([pm-wjdr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wjdr.toon))
- Sync prompt-03 create template with canonical contract ([pm-wi28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wi28.toon))
- Harden chained sandbox env detection per segment ([pm-wdgn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wdgn.toon))
- Sync prompt docs with close workflow ([pm-vx7l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-vx7l.toon))
- M5 follow-up: surface registerFlags on dynamic command help ([pm-vqam](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vqam.toon))
- M0: Deterministic serializer utilities ([pm-vdh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vdh.toon))
- Release-readiness loop: enforce global install bootstrap contract ([pm-uh4d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-uh4d.toon))
- Release-readiness maintenance loop 2026-03-07 run 10 ([pm-u8fr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-u8fr.toon))
- Release-readiness maintenance loop 2026-03-06 ([pm-tkie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tkie.toon))
- M0: Error model and exit code mapping ([pm-siz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-siz.toon))
- M6: Fixture corpus for restore import and search ([pm-si1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-si1.toon))
- Release-readiness verification and baseline dogfood sweep ([pm-scca](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-scca.toon))
- M4: Strict keyword search filter validation parity ([pm-r5ku](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r5ku.toon))
- Release readiness maintenance sweep ([pm-r59c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r59c.toon))
- M3: list and list-\* filters with deterministic sort ([pm-r0m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r0m.toon))
- M4 roadmap: Broader multi-factor tuning for hybrid search ([pm-qyyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qyyv.toon))
- M5 roadmap: Broader command sandbox API boundary ([pm-qype](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qype.toon))
- Harden sandbox guard for run-script test commands ([pm-q813](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-q813.toon))
- M5 roadmap: Todos import/export extension parity polish ([pm-pu4i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pu4i.toon))
- Docs contract sync for release readiness ([pm-pq8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pq8.toon))
- M5 follow-up: health extension activation probe ([pm-pjj7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pjj7.toon))
- M2: Append-only history writer ([pm-pg9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pg9.toon))
- M5: Hook lifecycle ([pm-p8p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p8p.toon))
- Sync AGENTS Pi create example with explicit contract ([pm-oie4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oie4.toon))
- Maintain release readiness 2026-03-09 ([pm-o4ky](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-o4ky.toon))
- M1: Lock acquire release with TTL and conflicts ([pm-nkx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nkx.toon))
- M4: Reindex command ([pm-nj3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nj3.toon))
- Pi wrapper numeric scalar flag parity ([pm-ni7x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ni7x.toon))
- M5 follow-up: health history stream read hook dispatch ([pm-ndb1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ndb1.toon))
- M5 hardening: enforce extension capability declarations ([pm-mwwp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mwwp.toon))
- Release-readiness drift audit and sync ([pm-mpd6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mpd6.toon))
- Release-readiness maintenance loop 2026-03-07 run 6 ([pm-mn6w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mn6w.toon))
- Reject flagged package-manager test runners in pm test --add ([pm-mlc3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mlc3.toon))
- Contributing maintainer bootstrap global-install parity ([pm-m91u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-m91u.toon))
- M5 roadmap: Broader call-site expansion for hooks ([pm-m6yd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m6yd.toon))
- Release-readiness audit and next hardening changeset ([pm-lfae](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lfae.toon))
- M5 follow-up: include built-in extensions in health probe ([pm-l88i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l88i.toon))
- M1: Markdown item parser and serializer ([pm-l4o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l4o.toon))
- M3: comments files docs and test commands ([pm-kwl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kwl.toon))
- Release-readiness maintenance loop 2026-03-08 run 1 (chore archival variant) ([pm-knwz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-knwz.toon))
- M4: Vector store adapters for Qdrant and LanceDB ([pm-kj4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kj4.toon))
- M0: Project scaffolding CLI entrypoint config loader ([pm-k8v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k8v.toon))
- Maintain release readiness 2026-03-09 (Run 3) ([pm-k4u5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k4u5.toon))
- Harden recursive test-all detection for global-flag invocation forms ([pm-k3zx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k3zx.toon))
- M5 roadmap: Runtime wiring for extension registrations ([pm-jvfw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jvfw.toon))
- Release-readiness maintenance loop 2026-03-07 run 4 ([pm-iziy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-iziy.toon))
- M5 follow-up: Extension API registration surface baseline ([pm-iuzs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-iuzs.toon))
- M4 roadmap: Advanced provider optimization ([pm-ip91](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ip91.toon))
- M5 roadmap: Beads import extension parity polish ([pm-imob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-imob.toon))
- M5: Built-in Pi tool wrapper extension ([pm-igv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-igv.toon))
- M4: Honor embedding batch + retry settings in semantic indexing ([pm-i25f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i25f.toon))
- Sync legacy prompt docs with create contract ([pm-h22w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-h22w.toon))
- AGENTS closed-sweep guidance and contract guard ([pm-gsd9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gsd9.toon))
- Harden settings serialization contract coverage ([pm-gm5l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gm5l.toon))
- M5: Renderer and command extension points ([pm-geq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-geq.toon))
- Close-workflow contract guard across docs and runtime ([pm-fvox](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fvox.toon))
- M5 follow-up: dispatch onWrite hooks for create and restore ([pm-f3q4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f3q4.toon))
- M4 follow-up: resolve search sonar warnings ([pm-f35q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f35q.toon))
- Release-readiness maintenance loop 2026-03-07 run 5 ([pm-f0e9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f0e9.toon))
- Maintain release readiness 2026-03-09 (Run 4) ([pm-eyoz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eyoz.toon))
- Pi wrapper workflow preset: close-task ([pm-ewoq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ewoq.toon))
- M3 follow-up: harden activity when history directory is missing ([pm-er7n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-er7n.toon))
- Bootstrap dogfood backlog and execute highest-priority gap ([pm-ep96](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ep96.toon))
- M4 roadmap: mutation-triggered semantic embedding refresh ([pm-eg97](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eg97.toon))
- Restore full todos import metadata parity ([pm-ecbn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ecbn.toon))
- Pi wrapper fallback path hardening ([pm-e6qb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e6qb.toon))
- Release-readiness maintenance loop 2026-03-07 run 11 ([pm-dyu6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dyu6.toon))
- Docs parity: mark Pi wrapper packaging polish as implemented ([pm-du3c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-du3c.toon))
- M1: ID generation and normalization ([pm-dgb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dgb.toon))
- Normalize duplicate milestone epics in tracker ([pm-d9yz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-d9yz.toon))
- Packaging hardening for npm release ([pm-cyj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cyj.toon))
- M4: Hybrid ranking and include-linked option ([pm-cwp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cwp.toon))
- M5 follow-up: classify applied extension migrations ([pm-cw6c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cw6c.toon))
- Optimize test-all dedupe across timeout variants ([pm-cnil](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cnil.toon))
- M5 roadmap: Broader override surfaces ([pm-bfd9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bfd9.toon))
- M5 roadmap: Pi tool wrapper packaging/distribution polish ([pm-bdz5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bdz5.toon))
- Make semantic search fully working using Ollama ([pm-b4pb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b4pb.toon))
- Create contract verification sample ([pm-awo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-awo.toon))
- Release-readiness maintenance loop 2026-03-07 run 9 ([pm-acx9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-acx9.toon))
- Release-readiness maintenance loop 2026-03-07 run 8 ([pm-a5ea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a5ea.toon))
- M2: Restore by timestamp or version with replay and hash validation ([pm-9lc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9lc.toon))
- Testing strategy and 100 percent coverage gates ([pm-912](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-912.toon))
- M6: CI matrix finalized ([pm-8z7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8z7.toon))
- README maintainer bootstrap parity with AGENTS ([pm-8mkp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8mkp.toon))
- M4 roadmap: Broader adapter optimization and persistence refinements ([pm-8ikr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8ikr.toon))
- Harden recursive test-all detection for npx package specs ([pm-8fvl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8fvl.toon))
- M5 follow-up: isolate override and renderer contexts ([pm-8d71](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8d71.toon))
- M5: Extension manifest loader and sandbox boundary ([pm-7sd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7sd.toon))
- Record explicit acceptance_criteria unset in create history metadata ([pm-7pp6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7pp6.toon))
- M4 follow-up: semantic/hybrid search limit=0 deterministic empty result ([pm-6mn1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6mn1.toon))
- M5 follow-up: dispatch lock lifecycle hooks ([pm-671u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-671u.toon))
- M3: test-all orchestration and dependency-failed exit handling ([pm-66o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-66o.toon))
- Guard todos import hierarchical ID preservation ([pm-57lj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-57lj.toon))
- M5 follow-up: normalize extension command path whitespace ([pm-433d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-433d.toon))
- M5 follow-up: report pending extension migrations in health ([pm-42oa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-42oa.toon))
- Release-readiness maintenance loop 2026-03-08 run 2 ([pm-3tjx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3tjx.toon))
- M5 follow-up: isolate hook execution contexts ([pm-3ses](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3ses.toon))
- Enforce close-command closure path ([pm-3nv9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3nv9.toon))
- M5 follow-up: dispatch onIndex hooks in gc command ([pm-3aeu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3aeu.toon))
- Release-readiness maintenance loop 2026-03-09 ([pm-36zp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-36zp.toon))
- M5 follow-up: validate extension hook registration handlers ([pm-30lh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-30lh.toon))
- M5 follow-up: enforce mandatory extension migration write gate ([pm-2p5x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2p5x.toon))
- M2: History and activity commands ([pm-2fj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2fj.toon))
- Release-readiness maintenance loop 2026-03-07 run 3 ([pm-204c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-204c.toon))
- Promote unblock-note to canonical workflow field ([pm-1p6f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1p6f.toon))
- M6: Command help and README examples validated in tests ([pm-15o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-15o.toon))
- Harden recursive test-all detection for pnpm dlx and npm exec launchers ([pm-11t5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-11t5.toon))
- M5: Harden extension command handler context sandbox ([pm-0e8w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0e8w.toon))
