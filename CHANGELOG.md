# Changelog

## Unreleased

### Added

- SDK author-time version-compatibility preflight: checkExtensionManifestCompatibility + assertExtensionManifestCompatible ([pm-1w0d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1w0d.toon))
- SDK author-once manifest synthesis: synthesizeExtensionManifest + assertExtensionManifestMatchesBlueprint ([pm-u5le](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u5le.toon))

### Changed

- Extract shared version-compat core (core/extensions/version-compat.ts); loader delegates, behavior-preserving ([pm-sjea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sjea.toon))

### Other

- assertExtensionManifestCompatible(manifest, target) — SDK testing assert ([pm-hng2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hng2.toon))
- checkExtensionManifestCompatibility(manifest, target) — pure author-time analyzer ([pm-knma](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-knma.toon))
- assertExtensionManifestMatchesBlueprint(manifest, blueprint): strict least-privilege CI guard against capability drift ([pm-pfxi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pfxi.toon))
- synthesizeExtensionManifest(blueprint, identity): generate a complete least-privilege ExtensionManifest from a blueprint ([pm-nr5j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nr5j.toon))

## 2026.6.23 - 2026-06-23

### Added

- SDK lintExtensionBlueprint + assertExtensionBlueprint: author-time preflight for composeExtension blueprints (capability drift, duplicate commands, empty surfaces) ([pm-9ect](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9ect.toon))
- SDK describeExtensionBlueprint: static author-time surface map of a composeExtension blueprint (author-time inverse of describeExtensionActivation) ([pm-tlpv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tlpv.toon))
- Declarative extension authoring: composeExtension blueprint + deriveExtensionCapabilities + defineExtensionManifest ([pm-iqq0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-iqq0.toon))
- pm extension/package describe: agent-facing CLI + MCP surface for describeExtensionActivation ([pm-l4c8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-l4c8.toon))
- SDK describeExtensionActivation: single-call introspection of every registered surface (complements assert\*/run\*) ([pm-16ue](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-16ue.toon))
- SDK authoring-time define\* typed builders for every extension registration surface ([pm-12tj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-12tj.toon))
- Unified extension test harness (createExtensionTestHarness): one fluent fixture binding all activate/assert/invoke/deactivate SDK helpers ([pm-jcyn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jcyn.toon))

### Fixed

- deriveExtensionCapabilities omits 'schema' for a CommandDefinition with inline flags (manifest under-grant would fail activation) ([pm-5758](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5758.toon))
- GH-340: Windows nightly telemetry OTLP cleanup EBUSY ([pm-zpe7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zpe7.toon))

### Other

- ADR: SDK author-time helpers are the static inverse of runtime extension checks (derive↔reconcile, describe-blueprint↔describe-activation, lint↔loader-enforcement+doctor) ([pm-4oio](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-4oio.toon))
- ADR: SDK define\* builders are zero-cost identity helpers (defineConfig pattern), generic for object defs / non-generic for function defs ([pm-3mph](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-3mph.toon))

## 2026.6.22 - 2026-06-22

### Added

- Add importers package scaffold and dependency-maintenance closeout ([pm-j5az](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j5az.toon))
- pm package init --capability search: scaffold search provider starter packages ([pm-pwai](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pwai.toon))
- pm package init --capability <kind\>: scaffold capability-targeted starter packages (commands\|hook) ([pm-nhby](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nhby.toon))
- SDK invoke helpers for importers & exporters: runRegisteredImporterForTest + runRegisteredExporterForTest ([pm-1p2u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1p2u.toon))
- SDK invoke helpers for search providers, vector store adapters and migrations ([pm-bd3u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bd3u.toon))
- Complete the SDK extension-invoke testing surface: runRegisteredHookForTest + override invoke helpers ([pm-miqm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-miqm.toon))
- SDK testing helper to invoke a registered extension command handler: runRegisteredCommandForTest ([pm-owm0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-owm0.toon))
- SDK deactivate test lifecycle: deactivateExtensionForTest + assertExtensionDeactivated helpers ([pm-0zn9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0zn9.toon))
- Least-privilege capability reconciliation: pm package doctor flags declared-but-unused extension capabilities + SDK assertExtensionCapabilityUsage ([pm-fk84](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-fk84.toon))

### Fixed

- Fix Windows nightly full-test path and permission assumptions ([pm-83rt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-83rt.toon))

### Other

- Package and extension scaffolds emit least-privilege manifest policy metadata ([pm-bav0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bav0.toon))

## 2026.6.21 - 2026-06-21

### Added

- Complete SDK package-author test-assertion surface: service-override + migration helpers ([pm-6pmp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6pmp.toon))
- item-format-migration: add format-version field to front-matter for future migration gating ([pm-ae1u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ae1u.toon))

### Fixed

- Windows nightly: secondary POSIX-separator + mocked-path test class (static-quality-gate, docs-skills-gate, bundle-cli, contracts-snapshot, smoke-npx-from-pack) ([pm-s5pe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s5pe.toon))
- Nightly windows-latest STILL red after pm-i84i: scriptModule test harness imports .mjs scripts via absolute file:// URL, shebang survives missing transform (SyntaxError) ([pm-dita](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dita.toon))

### Other

- Code quality & perf audit 2026-06-12 ([pm-nimu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nimu.toon))
- SDK testing helper for registerFlags registrations ([pm-oveq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oveq.toon))

## 2026.6.20 - 2026-06-20

### Added

- Search relevance eval harness: implement nDCG/MRR runner and gate in CI ([pm-u8n5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u8n5.toon))
- Offline BM25 lexical retrieval provider when no Ollama/OpenAI is configured ([pm-75k9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-75k9.toon))
- Add 120-file unit-test cap governance test to ci-workflow-contract.spec.ts ([pm-wc0d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wc0d.toon))
- Add integration test for background-refresh (instant mutations) non-blocking behavior ([pm-5rge](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5rge.toon))
- Add integration test for close-many --rollback checkpoint restore ([pm-7p4w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7p4w.toon))
- Add integration test for schema add-type / remove-type round-trip with governance.workflow_enforcement ([pm-4dtf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-4dtf.toon))
- Add remediation registry entry for validate_metadata_duplicate_issue_codes warning ([pm-sdbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-sdbo.toon))
- Add remediation registry entry for extension_update_health_partial_coverage warning ([pm-bdvm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bdvm.toon))
- gc --scope checkpoints: prune stale bulk-mutation checkpoint files ([pm-tyj8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tyj8.toon))
- LanceDB snapshot: add gc --scope embeddings to include pending-refresh.json and drift-cache coordination ([pm-3b1t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3b1t.toon))
- Sentry KNOWN_NOISY_CONSOLE_MESSAGE_PATTERNS maintenance: add a governance test to prevent silent accumulation of stale patterns ([pm-jxls](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jxls.toon))
- Add vitest.config.ts coverage include/exclude governance guidance to ARCHITECTURE.md ([pm-othr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-othr.toon))
- Add wiring-checklist reference card to ARCHITECTURE.md for new command authors ([pm-zyse](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zyse.toon))
- Add performance / startup-latency section to ARCHITECTURE.md ([pm-p37b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p37b.toon))
- Add Windows path-separator test coverage for fs-utils and store/paths ([pm-tq5t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tq5t.toon))
- Add nightly.yml failure alerting: notify on Windows/Node25 smoke failures ([pm-ehbb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ehbb.toon))

### Changed

- Refactor runUpdate (~950-line function) into table-driven per-field apply helpers ([pm-e7dn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-e7dn.toon))
- Replace 'as unknown as ItemMetadata' double-casts (9 sites) with typed mutation/replay returns ([pm-ul02](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ul02.toon))
- COMMANDS.md omits pm get and pm copy; command-families table missing get/copy/update-many/close-many ([pm-xvzm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xvzm.toon))

### Fixed

- pm-changelog over-escapes markdown in entry titles (parens + intra-word underscores) ([pm-3299](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3299.toon))
- Nightly windows-latest red since 2026-06-14: ~373 tests fail with 'SyntaxError: Invalid or unexpected token' from file://-URL TS dynamic imports + POSIX-separator assertions ([pm-i84i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i84i.toon))
- Accept --status all for duplicate-safe search and list filters ([pm-i02t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i02t.toon))
- pm health 2.3-3.1s in dev repo (~2x the 1.3s baseline): drift-scan cache hit still reads + content-hashes every history stream ([pm-c90s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c90s.toon))
- Daily auto-release was silently blocked 06-14..16 by a single stale, unresolved Sentry error (sentry-telemetry-gate is:unresolved has no time window) ([pm-nb08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nb08.toon))
- appendLineAtomic is not truly atomic: concurrent appends to history JSONL can interleave ([pm-xy9n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xy9n.toon))
- Project-scope extension install writes ~69MB node_modules per workspace (peer pm-cli + transitive Sentry/OTel) ([pm-oxq2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oxq2.toon))
- Fix ARCHITECTURE.md storage layout: add plans/, stories/, schema/, checkpoints/, runtime/ dirs ([pm-mcgf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mcgf.toon))
- Fix nightly cross-platform reliability: macOS realpath in extension-command test and Windows .cmd spawn EINVAL ([pm-gf6f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gf6f.toon))
- GH-293..296 CLI parser and search regression bundle ([pm-yy45](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yy45.toon))

### Removed

- Built-in type lists and storage layout drift: Plan missing; ARCHITECTURE.md still lists removed index/ dir ([pm-7u4z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7u4z.toon))

### Other

- Export hygiene: 1 dead export + ~57 exported-but-internal-only symbols ([pm-vn9l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vn9l.toon))
- Document search eval golden-query harness usage in TESTING.md ([pm-eg9k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eg9k.toon))
- Sentry tracesSampleRate is hardcoded at 0.2 — expose as configurable knob or document intent ([pm-gg8e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gg8e.toon))
- CLAUDE_CODE_PLUGIN.md drift: architecture tree shows 9/14 commands + 1/4 agents; compat table says plugin 1.0.0 (actual 1.4.0) ([pm-cxi9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cxi9.toon))
- Docs index missing EXTENSION_AUTHOR_CONTRACTS + MIGRATION_CLI_SIMPLIFICATION links; migration note predates --pm-path ([pm-c97q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-c97q.toon))
- pm todos import: positional source arg silently ignored + folder-not-found error omits --folder flag (beads parity) ([pm-90hp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-90hp.toon))
- Unknown-command did-you-mean misses executable aliases: 'pm shwo' gets no suggestion (show/view/comment not in candidate set) ([pm-i35t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i35t.toon))

## 2026.6.19 - 2026-06-19

### Added

- pm context --fields: per-row field projection for focus items (GH-156 follow-up to --depth full) ([pm-hnjf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hnjf.toon))
- pm list output formats: csv/table for human export (GH-154 remainder) ([pm-1lll](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1lll.toon))
- Dedupe merge workflow: pm dedupe-merge to consolidate duplicates (GH-163, builds on closed pm-4n1a detection) ([pm-jmld](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jmld.toon))
- pm plan discoverability: templates and auto-suggest for complex work (GH-158 remainder) ([pm-aer3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-aer3.toon))
- pm search: structured inline query syntax (tag:/status:) + matched-text highlighting (GH-157 remainder) ([pm-ldr1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ldr1.toon))
- Auto-compact policy: config-driven threshold to trigger pm history-compact automatically ([pm-0pnz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0pnz.toon))
- pm history-compact: expose --scope all-streams (history GC pass) for closed items ([pm-yj9w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yj9w.toon))
- History stream bulk-compaction: pm history-compact --all-over N to batch-compact large streams ([pm-f3pa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f3pa.toon))
- Add agent-identity dimension to telemetry events: surface PM_AUTHOR as hashed author_context ([pm-fbyu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-fbyu.toon))
- pm telemetry stats: add error_rate and resolution breakdown per command bucket ([pm-gsoe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gsoe.toon))
- Surface duration_ms percentile breakdown in pm telemetry stats (p50/p95 per command) ([pm-3n3b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3n3b.toon))
- GH-208: linked test sandbox ergonomics ([pm-52eh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-52eh.toon))
- Core read/validate integrity: exact-ID search rank guarantee across modes + parent-hierarchy cycle detection ([pm-rkie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rkie.toon))
- Validate governance accuracy: suppress false-positive duplicate-code & terminal-item metadata noise + files --remove input clarity ([pm-6bz1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6bz1.toon))
- Sub-hour duration granularity for scheduling: support minutes in --duration / event duration= ([pm-zoe4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zoe4.toon))

### Changed

- pm update --allow-audit-update: permit append-only --comment/--file/--doc evidence (GH-207) ([pm-kanu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kanu.toon))

### Fixed

- GH-206: test-all silent run process-liveness regression ([pm-mcxr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mcxr.toon))
- linked-test-adapters package install loses ESM module type ([pm-v8fy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v8fy.toon))
- Auto Release retries branch push after main advances ([pm-5oti](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5oti.toon))
- GH-284: align pm init required schema directories with health ([pm-hl9y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hl9y.toon))
- GH-215: enforce timestamps in history entries ([pm-u42x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u42x.toon))
- GH-280: pm validate does not detect circular parent references (hierarchy cycles A-\>B-\>A of any length) ([pm-8vul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8vul.toon))
- GH-281: exact-ID search match is rank-diluted in hybrid/semantic mode (keyword score normalized + capped by keyword weight) ([pm-oqgf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oqgf.toon))
- PR \#266 review feedback: tighten init and dynamic option validation ([pm-at1j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-at1j.toon))
- CI contracts snapshot temp cleanup can fail with ENOTEMPTY ([pm-c61g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c61g.toon))
- pm templates: unknown subcommand + flags silently fall back to 'list' (exit 0) instead of erroring ([pm-r2kd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r2kd.toon))
- GH-265: schema unknown subcommands must not create custom types ([pm-ablm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ablm.toon))
- GH-262: prevent path-like pm init from corrupting caller tracker settings ([pm-jek2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jek2.toon))
- Dynamic package commands should reject excess args and unknown parent tokens ([pm-nt1y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nt1y.toon))

### Other

- Repo-wide docstring coverage gate for source files ([pm-p4mw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p4mw.toon))
- SDK.md PM_PACKAGE_RESOURCE_KINDS drift: assets/prompts kinds missing ([pm-u8y9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-u8y9.toon))
- GH-277: files --remove path-only input clarity ([pm-k8ld](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k8ld.toon))
- GH-276: metadata check skip terminal items for planning fields ([pm-pktw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pktw.toon))
- GH-278: duplicate_issue_codes exclude items closed-as-duplicate ([pm-5fid](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5fid.toon))
- GH-275: duplicate_issue_codes skip legitimate parent/child code-prefix pairs ([pm-2nxe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2nxe.toon))
- PR \#274 second review follow-up: prefix, format, and owner scoring ([pm-89ur](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-89ur.toon))
- PR \#274 review follow-up: CodeQL and bot feedback ([pm-0bwe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0bwe.toon))
- GH \#267/\#271/\#272 follow-up: lifecycle automation, logical dependency validation, read format parity ([pm-8uhf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8uhf.toon))
- GH \#268-\#270 agent lookup and context output polish ([pm-x7g1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x7g1.toon))
- Dogfood audit 2026-06-12: ecosystem verification (CLI+SDK+packages) ([pm-krgd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-krgd.toon))

## 2026.6.17 - 2026-06-17

### Added

- GH-216: default lifecycle transition suggestions ([pm-y1z0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-y1z0.toon))
- GH-217: scheduling type creation shortcuts ([pm-76r5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-76r5.toon))
- Sentry PM-CLI-1R: 'cannot add command init as already have command init' — top-level init double-registration throws raw Commander error ([pm-zyez](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zyez.toon))
- GH-258: strict unknown-key rejection across all structured CSV/markdown link & metadata parsers (validation parity with test --add) ([pm-0v9k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0v9k.toon))
- Expose schema.unknown_field_policy via pm config set schema_unknown_field_policy ([pm-nnaq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nnaq.toon))
- pm schema list-fields / show-field / add-field / remove-field: CLI management of schema/fields.json ([pm-vhbf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vhbf.toon))
- GH-245: schema add-type --infer from title prefixes ([pm-tb42](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tb42.toon))
- Expose id_prefix, author_default, output.default_format, locks.ttl_seconds via pm config set ([pm-9byd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9byd.toon))
- pm schema apply-preset <agile\|ops\|research\>: standalone type-preset for already-initialized projects ([pm-86ob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-86ob.toon))

### Other

- Document schema/fields.json runtime custom field authoring in CONFIGURATION.md ([pm-izx5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-izx5.toon))

## 2026.6.16 - 2026-06-16

### Added

- pm focus: session default parent/context inheritance for new items (GH-161) ([pm-72xf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-72xf.toon))
- GH-235: detect duplicate logical issue code prefixes ([pm-rpag](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rpag.toon))
- GH-243: comments edit/delete lifecycle commands ([pm-4swf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4swf.toon))
- GH-244: surface provider/vector-store resolution source in pm health ([pm-gnu2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gnu2.toon))
- GH-236: governance metadata missing-field filters ([pm-mfl1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-mfl1.toon))
- GH-242: field-existence filters for list/search ([pm-hntj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hntj.toon))
- GH-241: stats content-field utilization metrics ([pm-7snq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7snq.toon))
- Finalize literal 100% coverage: close c8-ignore-masked gaps & remediate PR \#240 bot review ([pm-0xix](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0xix.toon))
- Apply Gemini correctness fixes & cover new branches (config/init/reindex/register-mutation) ([pm-bw70](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bw70.toon))
- Module-mirrored test reorganization: retire lane/wave naming, add shared script harness ([pm-m449](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m449.toon))
- Search: persistent search.hybrid_semantic_weight setting as default for pm search --semantic-weight ([pm-2xwh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2xwh.toon))
- Configurable min-score threshold for pm search: --min-score per-query override of search.score_threshold ([pm-cstl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cstl.toon))
- Search corpus: include type, priority, parent, assignee fields in keyword and semantic corpus ([pm-jyie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jyie.toon))
- pm search filter parity with pm list: add --updated-after/before, --created-after/before, --assignee, --sprint, --release, --parent ([pm-13nx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-13nx.toon))
- pm search keyword mode: --match-mode (and/or/exact) + default result limit (GH-181 remainder) ([pm-i1z6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i1z6.toon))
- pm context --depth full: comprehensive snapshot (all sections, no per-section cap) (GH-156) ([pm-j0vc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j0vc.toon))
- pm list --no-truncate/--all: explicit override of any --limit + surface total vs returned count (GH-154) ([pm-0c0j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0c0j.toon))
- pm context --parent <id\>: scope snapshot to a single epic/parent subtree ([pm-ds0m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ds0m.toon))
- pm get: include child rollup summary for Milestone/Epic items (GH-155) ([pm-gcm3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gcm3.toon))
- pm validate: missing-link owner attribution (GH-210) + type-default estimate backfill (GH-212) ([pm-gnnb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gnnb.toon))
- Metadata governance & coverage observability (missing-field filters, stats breakdowns, validate full-id lists, aggregate explicit labels) ([pm-yq7m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yq7m.toon))
- pm close: short aliases -m/-r/-d for --message/--reason/--duplicate-of (GH-226) ([pm-i1mu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i1mu.toon))
- pm create/update --body-file: load body markdown from a file (GH-214) ([pm-7c48](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7c48.toon))

### Changed

- Small verified cross-file duplications (4 pairs) + static-gate duplicate scan does not cover src/cli ([pm-z2gi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-z2gi.toon))
- LOC growth watch: 5 src files back over 2000 lines (cap 3400) after 2026-05-25 barrel splits ([pm-k1im](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k1im.toon))
- health.ts re-implements doctor.ts capability-guidance helpers verbatim instead of importing the exported versions ([pm-aabt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-aabt.toon))
- Dedupe history-rewrite orchestration block triplicated across history-redact/repair/compact ([pm-bzgt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-bzgt.toon))
- pm update-many: --filter-ac-missing/--filter-estimates-missing/--filter-resolution-missing selection filters for bulk backfill (GH-220) ([pm-wbak](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wbak.toon))

### Fixed

- GH-256: update-many --dry-run skips field validation (priority/type/status/deadline) ([pm-v4tb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v4tb.toon))
- GH-253: invalid --type create error hardcodes .agents/pm path, ignoring active --pm-path ([pm-nd08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nd08.toon))
- GH-252: pm get --json places body outside item (parity with list --include-body) ([pm-hofv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hofv.toon))
- GH-248: fix schema add-type silent slug-collision overwrite + malformed-name acceptance ([pm-3l0f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3l0f.toon))
- GH-250: pm close checks item existence before the close-reason gate ([pm-1jtl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1jtl.toon))
- GH-249: create --status closed bypasses governance.require_close_reason ([pm-4a1p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4a1p.toon))
- Extension activation failure is invisible outside pm health --json: extension list shows ok, no stderr hint, commands partially registered ([pm-yffj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yffj.toon))
- pm create <type\> --title X silently ignores positional type, defaults to Task ([pm-8sr3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8sr3.toon))
- c8 ignore end (invalid keyword) silently masked source coverage; literal-100% gate passed on hidden code ([pm-dg8j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dg8j.toon))
- GH-205: surface telemetry flush/probe + OTEL export diagnostics in pm health ([pm-hx5a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hx5a.toon))
- GH-209 follow-up: OTEL span export keeps the CLI alive ~10s (and can exit 13) when the traces endpoint is unreachable ([pm-25se](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-25se.toon))

### Security

- Track open Dependabot alerts \#39/\#40/\#41 (vite and @opentelemetry/core) ([pm-c24n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c24n.toon))

### Other

- Content-field & governance introspection (GH-241/242/236) ([pm-php4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-php4.toon))
- GitHub issue triage 2026-06-12 ([pm-tk1z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tk1z.toon))
- Slim guided-error boilerplate in agent contexts; lead unknown-command Examples with the did-you-mean candidate ([pm-q0kr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q0kr.toon))
- PR \#240 review: applied vs declined Gemini findings (with rationale) ([pm-lg65](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-lg65.toon))
- Close c8-exposed coverage gaps in src/cli/commands/create.ts to 100% ([pm-eifq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eifq.toon))
- Close c8-exposed coverage gaps in src/cli/commands/contracts.ts and restore.ts to 100% ([pm-dmuq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dmuq.toon))
- Close c8-exposed coverage gaps in src/cli/commands/history-redact.ts and normalize.ts to 100% ([pm-byl1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-byl1.toon))
- Test-suite dedup & best-practice audit (post module-mirror reorg) ([pm-2nqx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2nqx.toon))
- Source-correctness audit of all-source-100%-coverage branch src/ edits ([pm-e2jt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-e2jt.toon))
- tests/unit is at exactly 120/120 spec files: zero headroom before Gates(static) fails; consolidation candidates identified ([pm-vks9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-vks9.toon))
- ADR: test organization convention — module-mirrored spec files, no lane/wave naming ([pm-kjmx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-kjmx.toon))
- ADR: literal all-src coverage supersedes curated include/exclude allowlist ([pm-w13j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-w13j.toon))
- Literal 100% all-source test coverage & module-mirrored test reorganization ([pm-xau3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-xau3.toon))
- Coverage to 100%: packages, plugins, and docs examples ([pm-6tch](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6tch.toon))
- Coverage to 100%: src/core, src/mcp, and src/sdk modules ([pm-krwu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-krwu.toon))
- Coverage to 100%: src/cli command handlers (group B — query, search, calendar, test, init, extension) ([pm-7v9s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7v9s.toon))
- Coverage to 100%: src/cli command handlers (group A — mutation, history, storage, schema) ([pm-ud1x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ud1x.toon))
- Coverage to 100%: src/cli infrastructure (registration, bootstrap, help, main) ([pm-uvxc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uvxc.toon))
- Coverage to 100%: build, release, and smoke scripts ([pm-f2ne](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-f2ne.toon))
- Document and test telemetry env-var surface: PM_TELEMETRY_DISABLED, PM_NO_TELEMETRY, PM_TELEMETRY_SOURCE_CONTEXT, PM_TELEMETRY_OTEL_DISABLED, PM_TELEMETRY_INLINE_FLUSH ([pm-r7md](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r7md.toon))
- pm validate: --all-affected-ids flag + never truncate ID lists in JSON mode (GH-224) ([pm-o0d2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-o0d2.toon))
- pm aggregate: explicit (unassigned)/(none) labels for blank group keys in all output modes (GH-225) ([pm-zcx9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zcx9.toon))
- pm stats: --by-assignee/--by-tag/--by-priority breakdowns + --metadata-coverage + lifecycle/type adoption (GH-213/218/219) ([pm-gq27](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gq27.toon))
- pm list: --filter-ac-missing/--filter-estimates-missing/--filter-resolution-missing/--filter-metadata-missing (GH-228) ([pm-fryg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fryg.toon))
- Shared core/governance/metadata-coverage primitive: missing-field predicates + coverage % + grouped lifecycle counts ([pm-hm1q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hm1q.toon))
- pm close: when require_close_reason is on, accept --resolution text as the close reason instead of hard-blocking ([pm-7x8d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7x8d.toon))

## 2026.6.13 - 2026-06-13

### Changed

- Dedup private Levenshtein implementations onto shared OSA helper ([pm-dzcx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dzcx.toon))

### Fixed

- Claude Code plugin install spec drift: README says pm-cli@pm but plugin name is pm-claude ([pm-m4bx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m4bx.toon))
- Compact strict-create recovery duplicates missing fields under two keys ([pm-3rjo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3rjo.toon))
- GH-209: successful pm mutations can exit 13 from unsettled top-level await ([pm-1byt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1byt.toon))
- pm-mcp bin is dead on npm installs: main-module guard fails under symlinked argv\[1\] (silent exit 0, no JSON-RPC output) ([pm-qtbc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qtbc.toon))
- pm validate --check-files misclassifies existing directories as deleted (GH-203, prune/auto-fix data-loss path) ([pm-b1ni](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b1ni.toon))

### Other

- Ecosystem audit + GH-204..208/210 remediation session 2026-06-13 ([pm-y7sc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-y7sc.toon))
- CI gap: plugin/package markdown pushed to main runs no functional workflow ([pm-5909](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5909.toon))
- Compact strict create recovery for agents ([pm-tjvl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tjvl.toon))

## 2026.6.12 - 2026-06-12

### Added

- pm files/docs: standalone --note flag alongside --add (GH-170) ([pm-pfnx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pfnx.toon))
- Add pm health 'locks' check: surface stale item-claim counts before gc is needed ([pm-xo1n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xo1n.toon))
- pm history-repair --all: bulk drift repair across streams (GH-171) ([pm-9ftr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9ftr.toon))
- pm validate --check-files: classify stale linked paths (moved vs deleted) and offer --prune-missing (GH-184) ([pm-0v2m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0v2m.toon))
- pm validate --auto-fix: apply safe remediations automatically (GH-179, GH-153 interactive part, GH-167 backfill part) ([pm-c3sz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-c3sz.toon))
- pm validate metadata report grouped by item type (GH-172) ([pm-pmyq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pmyq.toon))

### Fixed

- PR \#200 review: batch validate prune-missing auto-fix removals ([pm-60p0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-60p0.toon))
- Session 2026-06-11: validation auto-fix & self-repair PR (validate --auto-fix/--prune-missing/grouped metadata, history-repair --all, health locks, files/docs --note, plan --step accumulate, consent CI guard, completion drift) ([pm-dhrp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-dhrp.toon))
- MCP pm_files discover/apply/discoveryNote params are declared but ignored by the files action handler ([pm-wcaa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wcaa.toon))
- Lifecycle subcommand flags duplicated on the parent extension/package command are silently dropped (commander hoists them) ([pm-df9k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-df9k.toon))
- Telemetry first-run prompt CI guard is inverted: CI=true does not skip, only CI=false/0/no/off does ([pm-0hx2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0hx2.toon))
- pm plan create: repeated --step silently keeps only the last value instead of accumulating steps ([pm-6mit](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6mit.toon))
- pm validate lifecycle: auto-fix for active items with closed/terminal parents (GH-168) ([pm-8jss](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8jss.toon))

### Other

- PR \#200 review: contract and defensive hardening follow-up ([pm-im0s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-im0s.toon))
- Refresh Sentry expected handled CLI classifier for 2026-06-11 dogfood CommandErrors ([pm-lg9i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lg9i.toon))
- Milestone calendar_item_without_schedule warning should include actionable hint (GH-174) ([pm-2cgu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2cgu.toon))
- Shell completion drift: show-status missing from bash/zsh/fish schema subcommand lists ([pm-6qi8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6qi8.toon))

## 2026.6.11 - 2026-06-11

### Added

- MCP pm_list/pm_search: expose active filter summary in compact output so agents know what was applied ([pm-rmjy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rmjy.toon))
- Add narrow pm_append MCP tool for agent log-seeding without pm_run passthrough ([pm-7u9j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7u9j.toon))
- Add pm_schema and pm_config narrow MCP tools for workspace configuration via MCP ([pm-v68d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v68d.toon))

### Fixed

- GH-191: test --add command parser should accept quoted commands containing -- ([pm-vcr2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vcr2.toon))

### Other

- Contract schema golden-file must cover MCP tool inputSchema shapes — current snapshot only covers CLI flags ([pm-4os2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-4os2.toon))

## 2026.6.10 - 2026-06-10

### Added

- pm close --duplicate-of: structured duplicate tracking with auto-populated closure fields (GH-183, GH-160) ([pm-xnkd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-xnkd.toon))
- pm test --run selectors: --match / --only-index / --only-last (GH-194) ([pm-p86h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-p86h.toon))
- pm context: per-epic completion stats + recently_created/unparented sections (GH-187, GH-182) ([pm-ojpq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ojpq.toon))
- Root --id-only flag: minimal mutation output (id+status) for agent automation loops (GH-195) ([pm-esf6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-esf6.toon))
- pm aggregate --completion: closed/total ratio and completion_pct per group (GH-185) ([pm-eaer](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-eaer.toon))
- pm list: include parent in default compact projection when set (GH-180) ([pm-awfr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-awfr.toon))
- Combined PR: duplicate-aware close, parent fail-fast, id-only output, context/aggregate completion stats, robust test add/run ([pm-z9e9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-z9e9.toon))
- Embedding provider migration guide + pm reindex --migrate: automated full reindex on model/provider change ([pm-wt0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-wt0g.toon))
- Settings read cache: memoize readSettingsWithMetadata across the 3-5 reads per command ([pm-2bn5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2bn5.toon))
- Incremental reindex --mode semantic --stale-only: skip already-up-to-date vectors ([pm-o3nr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-o3nr.toon))
- Add MCP pm_context, pm_contracts, pm_plan, pm_health integration tests ([pm-8d00](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8d00.toon))
- First-party exemplar package for registerCommand + registerFlags + registerParser (commands capability pattern) ([pm-1js9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1js9.toon))
- Add importer/exporter options arg and command-def examples to SDK.md ([pm-btwe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-btwe.toon))
- pm_max_version default-BLOCK should have a per-layer warn-only toggle in settings ([pm-k5e8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-k5e8.toon))
- Extension teardown: per-deactivate timeout guard so a hanging deactivate() cannot block host shutdown/reload ([pm-bujg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bujg.toon))

### Fixed

- GH-189: create --parent should fail fast on unresolved references ([pm-p9hw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p9hw.toon))
- Classify tracker-not-initialized Sentry CommandErrors as expected handled CLI errors ([pm-w7jq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-w7jq.toon))
- GH-190: SDK locateItem should default idPrefix or throw explicit argument errors ([pm-rjh9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rjh9.toon))
- Telemetry queue max_attempts backlog health warning: surface items near retry exhaustion in pm health ([pm-irc7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-irc7.toon))
- Harden history replay and compact diff against malformed patch entries ([pm-kf5q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kf5q.toon))
- MCP server: request-scoped extension registries (process-global set/clear can race under concurrent native-action requests) ([pm-bl6m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bl6m.toon))
- Fix Windows Nightly smoke cleanup helper import ([pm-uzty](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-uzty.toon))

### Security

- Extension sandbox profiles are advisory-only — no runtime enforcement of declared permission boundaries ([pm-pl53](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-pl53.toon))
- Declare trusted=true, sandbox_profile, and permissions on all 9 first-party package manifests ([pm-iljy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-iljy.toon))

### Other

- Run verification matrix and temp-dir smoke for active cycle ([pm-rav7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rav7.toon))
- Upgrade pm-changelog to 2026.6.9 and validate changelog fidelity ([pm-kx7v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kx7v.toon))
- Close stale GH issues, clarify dedupe-audit docs, and bump @sentry/node ([pm-utd6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-utd6.toon))
- SDK author-ergonomics batch: extension-manifest JSON Schema, getWorkspaceContracts memoization, FlagDefinition type/value_type unification ([pm-l0jd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-l0jd.toon))
- Document pm-linked-test-adapters package in EXTENSIONS.md and TESTING.md ([pm-yj8n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-yj8n.toon))

## 2026.6.9 - 2026-06-09

### Added

- PmPackageResourceKind is missing 'assets' and 'prompts' as canonical resource types ([pm-z9ho](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-z9ho.toon))
- Extension activation: no teardown/deactivation hook — extensions cannot clean up timers, connections, or state ([pm-k1e4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-k1e4.toon))
- Extension API missing self-identity accessor: extensions cannot read their own name, layer, or version at activation ([pm-qo36](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qo36.toon))
- registerItemFields/registerItemTypes: validate declared field type against known coercion kinds with did-you-mean ([pm-oll8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oll8.toon))

### Fixed

- Extension FlagDefinition lacks 'list' and 'default' fields — extension-registered flags cannot match core comma-list contract ([pm-ltbr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ltbr.toon))

### Other

- SDK lacks assertRegisteredCommandOverride testing helper (coverage gap in testing.ts) ([pm-aw7d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-aw7d.toon))

## 2026.6.8 - 2026-06-08

### Added

- list/search: trim default filters/projection/sorting/now trailer in compact/agent mode ([pm-vhx6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vhx6.toon))
- MCP pm_health defaults to the compact summary projection for token-efficient agent health checks ([pm-yjub](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-yjub.toon))
- pm-changelog classifier mis-routes feature titles containing the word 'remove'/'delete' into the Removed section ([pm-ybiz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ybiz.toon))
- Add schema show-status status inspection ([pm-qpus](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qpus.toon))

### Changed

- Remove dead code and dedupe pm-cli version readers into resolvePmCliVersion ([pm-wrqk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wrqk.toon))

### Fixed

- CI smoke npx pack cleanup can fail with ENOTEMPTY ([pm-i2xg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i2xg.toon))
- MCP narrow tools silently drop top-level filter keys (pm_list {type:Task} returns unfiltered) ([pm-jozc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jozc.toon))
- list/search --tags hard-refuses (exit 2) while create --tag auto-corrects — accept --tags as a never-block alias ([pm-6l17](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6l17.toon))
- MCP tools/call structuredContent.result is always present but isError path lacks it — inconsistent envelope ([pm-l40h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l40h.toon))
- MCP server serverInfo.version is hardcoded '1.0.0' — should reflect package.json version ([pm-2nvw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2nvw.toon))
- Fix inaccurate PR CI matrix description in CONTRIBUTING.md ([pm-t73k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-t73k.toon))
- Fix MCP tool-count doc drift (18/21 -\> 22, add pm_copy) and lock the claude-plugin smoke to the live tools/list count ([pm-7tvx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7tvx.toon))
- Fix: --path/PM_PATH did not discover .agents/pm under a project root (never-block dead-end) ([pm-ryik](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ryik.toon))
- Fix: pm close/close-many hard-failed without a reason via a generic, non-actionable error (P0 never-block) ([pm-g799](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g799.toon))
- Document pm-changelog external repo dependency and pad-match fix in RELEASING.md ([pm-97yv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-97yv.toon))
- writeFileAtomic cross-device rename safety: handle EXDEV when tmp and target are on different mounts ([pm-6vv6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6vv6.toon))
- Drift-cache gc scope: pm gc --scope runtime should clear history-drift-cache.json ([pm-7n8v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7n8v.toon))
- MCP ping method not handled — returns 'Unsupported MCP method' instead of empty response ([pm-lold](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lold.toon))

### Security

- Pin CodeQL action refs to immutable SHAs in codeql.yml ([pm-ji5c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ji5c.toon))

### Other

- Warn in pm health when server-advertised max telemetry schema version exceeds client version ([pm-dfhp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dfhp.toon))
- Ecosystem-wide PM living-context audit & forward-backlog rebuild (2026-06-07) ([pm-8u2a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-8u2a.toon))
- ADR: Agent self-repair via a centralized remediation registry surfaced through pm health --json and pm validate --fix-hints ([pm-cc04](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-cc04.toon))
- ADR: Test-coverage governance — 100% V8 thresholds with a curated include/exclude allowlist, a tests/unit file-count cap, and pure-logic extraction into small core modules ([pm-7sq6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-7sq6.toon))
- 2026-06-07 agent UX package ecosystem and path guardrail hardening ([pm-yo3f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yo3f.toon))
- 2026-06-07 pm CLI ecosystem audit lanes ([pm-xm98](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-xm98.toon))

## 2026.6.7 - 2026-06-07

### Added

- pm-governance-audit: onWrite/onRead hooks exemplar (hooks capability) ([pm-7m8p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7m8p.toon))
- pm history-compact: checkpoint-based history stream compaction ([pm-3pbq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3pbq.toon))
- Advanced relevance tuning (post-v0.1): cross-encoder reranking + query expansion ([pm-7tsx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7tsx.toon))
- Configurable vector store collection name (post-v0.1 adapter optimization) ([pm-usw2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-usw2.toon))
- pm copy <id\>: clone an item to a new ID with optional title override ([pm-m4nn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m4nn.toon))
- pm aggregate --sum/--avg: numeric aggregation over filtered items ([pm-bvns](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bvns.toon))
- pm list --tree: recursive subtree rendering with indented hierarchy ([pm-vbzc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vbzc.toon))
- Configurable semantic corpus character limit (search.embedding_corpus_max_characters) ([pm-cxdg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cxdg.toon))
- Per-query hybrid weight override: pm search --semantic-weight (post-v0.1) ([pm-cy8i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cy8i.toon))

### Fixed

- Track removal of TOON upstream bracket-bug workaround when upstream fix ships ([pm-idnz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-idnz.toon))
- Drift-scan cache can false-hit on mtime-preserving file copies ([pm-up22](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-up22.toon))
- Search relevance evaluation harness (golden queries, nDCG) for regression detection ([pm-22x2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-22x2.toon))

### Security

- Harden afterCommand coverage and GitHub code-scanning visibility ([pm-izid](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-izid.toon))

### Other

- Agent command compatibility and package command discovery ([pm-7etc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7etc.toon))
- Package install fallback hints and extension collision plans ([pm-e48i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e48i.toon))
- Stabilize npx onboarding path for scoped pm package ([pm-pgew](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pgew.toon))
- Publish pm-github starter package as a community reference (credential-requiring pattern) ([pm-zw0n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zw0n.toon))
- Make list --ids repeatable for focused agent working-set refresh ([pm-42tb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-42tb.toon))
- SDK testing helper for vector store adapter registrations ([pm-475h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-475h.toon))
- SDK testing helper for package manifest resource assertions ([pm-xevy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xevy.toon))
- SDK testing helpers for schema package registrations ([pm-01bm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-01bm.toon))
- PR \#123 review: make governance hook sidecar logging fail-open ([pm-mzlu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mzlu.toon))
- Config-driven optional close reason via governance.require_close_reason ([pm-peyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-peyv.toon))

## 2026.6.6 - 2026-06-06

### Added

- pm telemetry local-analytics subcommand (status/flush/stats/clear) ([pm-6xdl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6xdl.toon))
- Add Claude Code rows to docs read-path and README start-here tables ([pm-pwdx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-pwdx.toon))
- Add AGENTS.md/README workflow-update checkbox to the PR template ([pm-0sqs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0sqs.toon))
- Create ONBOARDING.md for new maintainers and first-time contributors ([pm-oh5h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oh5h.toon))
- Add markdown broken-link check to the docs CI gate ([pm-mp6c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mp6c.toon))
- Add pm stats --storage: aggregate history-stream metrics ([pm-mnee](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-mnee.toon))
- pm history --diff: per-entry field-level before/after diffs ([pm-puvn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-puvn.toon))
- Add pm gc --scope locks: sweep expired lock debris from crashed processes ([pm-d70h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d70h.toon))
- Add MCP protocol handshake tests (initialize + tools/list + unknown-tool error) ([pm-kl11](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kl11.toon))
- Add narrow MCP tools pm_notes, pm_learnings, pm_deps (agent self-documentation + deps) ([pm-hywv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hywv.toon))

### Changed

- Export PM_TOOL_PARAMETERS_SCHEMA_VERSION constant and bind all assertion sites ([pm-r9sz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r9sz.toon))
- Generate pm_run action-list description from PM_TOOL_ACTIONS to end prose/enum drift ([pm-fd8n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fd8n.toon))

### Fixed

- File-backed schema sections (types/statuses/fields/type_workflows) leak into settings.json on writeSettings ([pm-haak](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-haak.toon))
- MCP stdio server processes JSON-RPC lines concurrently → pipelined mutations on the same item lock-conflict ([pm-3puw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3puw.toon))
- PRD/contract drift: reminders_weight and events_weight missing from search.tuning docs ([pm-75du](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-75du.toon))
- MCP TOOL_SCHEMA_BASE additionalProperties:true silently swallows typo'd top-level args ([pm-qxwu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qxwu.toon))

### Other

- Telemetry schema versioning/negotiation preparation ([pm-t4wb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t4wb.toon))
- Contract schema golden-file snapshot gate in CI ([pm-d6kq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-d6kq.toon))
- Document changelog classifier keyword routing for contributors ([pm-5vsv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5vsv.toon))
- Evaluate commander 15.0.0 major upgrade (current 14.0.3) ([pm-7j8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7j8t.toon))
- Clean up stale closed tracker-item references in docs/ header lines ([pm-e376](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-e376.toon))
- Drift-lock the .agents/plugins/marketplace.json (pm-local) manifest in the plugin contract test ([pm-g3xl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-g3xl.toon))
- History & storage observability: pm gc locks scope, pm history --diff before/after, pm stats --storage ([pm-l709](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-l709.toon))
- MCP & contract platform maturity PR (pm-5k4v): narrow tools pm_notes/pm_learnings/pm_deps + schema-base hardening + action-list drift-gen + schema-version constant + handshake tests ([pm-at83](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-at83.toon))
- Document the create vs mutateItem dual write-path contract ([pm-k5r6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k5r6.toon))
- Document capture_level semantics for extension authors ([pm-te9x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-te9x.toon))

## 2026.6.5 - 2026-06-05

### Added

- pm validate --fix-hints: machine-executable remediation commands per check ([pm-6m3y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6m3y.toon))
- Structured remediation map on pm health --json for all non-extension checks ([pm-0hnu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0hnu.toon))
- pm close-many: bulk-close matched items with shared reason and validate-close semantics ([pm-i17g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i17g.toon))
- pm update-many --ids: explicit ID-list filter for targeted bulk mutations ([pm-1h99](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1h99.toon))
- pm search --status filter (parity with pm list) ([pm-ec4s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ec4s.toon))
- pm list --updated-after/--created-after incremental date filters ([pm-y138](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-y138.toon))
- Reusable external npm package ecosystem smoke harness ([pm-vnjh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vnjh.toon))
- Per-type workflow / allowed-transitions config (schema/workflows.json) ([pm-f4r1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f4r1.toon))
- pm schema add-status: register custom statuses (complement to add-type) ([pm-e77a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e77a.toon))
- pm init --type-preset agile\|ops\|research: batch-register domain item types ([pm-1lkm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1lkm.toon))
- pm schema list / pm schema show: inspect registered custom and built-in types ([pm-qq69](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qq69.toon))
- First-party hooks capability exemplar (lifecycle hook) for pm-izsi completion ([pm-s40s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-s40s.toon))
- Add generic create/update setter for extension item fields ([pm-qvdj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qvdj.toon))

### Changed

- 2026-06-02 commander SDK custom-field and extension-output hardening ([pm-lwtx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lwtx.toon))

### Fixed

- Sentry reliability gate blocks release on dogfood-generated expected CLI errors (brittle per-count + missing standup-export patterns) ([pm-yohx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yohx.toon))
- Auto Release 2026-06-01 tagged v2026.6.1 but npm publish never completed (latest npm = 2026.5.31) ([pm-kcba](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kcba.toon))
- governance.create_default_type is not settable via pm config set ([pm-jpwo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jpwo.toon))
- Warn on global service and renderer override footguns ([pm-5teq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5teq.toon))
- Fix GitHub \#98 dependency --dep type parsing ([pm-dlfq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dlfq.toon))

### Removed

- pm schema remove-type: delete a custom type from types.json ([pm-k8ik](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k8ik.toon))

### Other

- Surface settings_read_invalid_schema warning proactively on affected commands ([pm-7tcw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7tcw.toon))
- Agent context & bulk-ops primitives: incremental date filters, search --status, --ids targeting, close-many ([pm-j2ig](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-j2ig.toon))
- After-command hook affected item transition context ([pm-qzv2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qzv2.toon))
- Sentry gate expected handled CLI classifier refresh ([pm-flbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-flbo.toon))
- SDK extension hook context and manifest capability guardrails ([pm-e9ut](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e9ut.toon))
- 2026-06-02 latest-main ecosystem dogfood and SDK review ([pm-kddw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kddw.toon))

## 2026.6.2 - 2026-06-02

### Added

- pm-search-advanced: register a built-in SearchProvider exemplar (search capability) ([pm-bqpg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bqpg.toon))
- pm-todos + pm-beads: migrate to registerImporter/registerExporter (importers capability exemplar) ([pm-13bn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-13bn.toon))
- First-class importer/exporter registration: registerImporter/registerExporter accept command metadata (description/flags/intent/examples) ([pm-7qjk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7qjk.toon))

### Other

- 2026-06-01 package ecosystem SDK agent UX audit and hardening ([pm-z0ip](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z0ip.toon))
- 2026-05-31 late latest-main ecosystem dogfood and review closure ([pm-etxf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-etxf.toon))

## 2026.6.1 - 2026-06-01

### Added

- Extend SDK testing helpers to cover hooks, search providers, importers/exporters ([pm-kfd8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kfd8.toon))
- Extension manifest pm_max_version (upper compatibility bound) ([pm-4gw6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4gw6.toon))
- Declare pm_min_version in all 8 first-party package manifests ([pm-nf2q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-nf2q.toon))
- Build package-first pm ecosystem and install command ([pm-59gj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-59gj.toon))
- SDK ergonomics: package-safe error base, version negotiation, document PM_CLI_PACKAGE_ROOT ([pm-oxyo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oxyo.toon))

### Changed

- Vector store: prune orphans on reindex + reset on embedding-model/dimension change ([pm-xutw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xutw.toon))
- Dedup create/update parsers + optional command-file splits ([pm-8ehg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8ehg.toon))

### Fixed

- Calendar: normalize recurrence exdates by instant + document count-window semantics ([pm-qcsz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qcsz.toon))

### Security

- ADR: Extension sandbox profiles are advisory governance attestations, not enforced isolation ([pm-6ef3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-6ef3.toon))

### Other

- Governance test: enforce manifest pm_min_version and manifest_version on all first-party packages ([pm-exrw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-exrw.toon))
- Ecosystem PM living-map audit & reorganization methodology ([pm-knqw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-knqw.toon))
- ADR: Startup-latency strategy (prebuilt JS, lazy per-command imports, external deps, no single bundle) ([pm-irp1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-irp1.toon))
- Verify living-map: ecosystem coverage gaps ([pm-xmhn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xmhn.toon))
- ADR: Stable CLI exit-code contract (0 success, 1 generic, 2 usage, 3 not_found, 4 conflict, 5 dependency_failed) ([pm-x1z3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-x1z3.toon))
- Ecosystem-wide PM living-context map: audit, ADRs, roadmap, and forward backlog (2026-05-31) ([pm-w7f2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-w7f2.toon))
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
- ADR: Health checks are advisory vs blocking: telemetry\_\* never flips ok:false ([pm-jezo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-jezo.toon))
- ADR: Git-native filesystem is the database (one file per item; no server, daemon, or DB engine) ([pm-i7i4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-i7i4.toon))
- Audit domain: Core CLI command surface & item lifecycle ([pm-hqka](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hqka.toon))
- ADR: Append-only JSONL history with SHA-256 hash chain ([pm-hg0k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-hg0k.toon))
- Audit domain: Search & semantic (keyword/semantic/hybrid, embeddings, vector stores) ([pm-h7n6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h7n6.toon))
- Living-map verification & gap-closure pass (continuation, 2026-05-31) ([pm-h31a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h31a.toon))
- Verify living-map: dedup & definition quality ([pm-f6rm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f6rm.toon))
- ADR: Date-based calendar versioning with daily automated release and manual same-day follow-ups ([pm-ee1k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-ee1k.toon))
- ADR: Expected-error classification keeps Sentry signal-to-noise high ([pm-c8qa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-c8qa.toon))
- ADR: Never-block agent UX: high-frequency aliases are executable bootstrap rewrites, not suggestion text ([pm-bwlz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-bwlz.toon))
- Audit domain: Storage, item-store, history, TOON, restore ([pm-ar08](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ar08.toon))
- ADR: Config-driven runtime schema (4-file model) over hard-coded type/status/field registries ([pm-a859](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-a859.toon))
- ADR: Plugin hybrid model: pm is the git-native store; the editor/agent panel is a live session view ([pm-7c4t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-7c4t.toon))
- ADR: CHANGELOG is auto-generated from closed items by pm-changelog; never hand-edited ([pm-6san](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-6san.toon))
- ADR: Hybrid search = normalized linear interpolation with a configurable weight ([pm-66ig](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-66ig.toon))
- Audit domain: Config, schema, custom types & init ([pm-4uxz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4uxz.toon))
- ADR: Single-source contracts: cli-contracts.ts is the authoritative CLI+MCP+contracts surface ([pm-2evy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-2evy.toon))
- ADR: LanceDB pure-JSON snapshot vector store (no native bindings) ([pm-164t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-164t.toon))
- ADR: Collision-checked random short IDs (configurable prefix + base36 token) ([pm-12j1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-12j1.toon))
- Refresh changelog after PR closeout merge ([pm-2y28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2y28.toon))
- 2026-05-31 external package audit and agent contract hardening ([pm-kd9n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kd9n.toon))
- Runtime-resolved shell completion for custom statuses/types via helper command ([pm-q4zx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q4zx.toon))
- Lazy extension activation: defer import+activate until a command needs contributions ([pm-5wb6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5wb6.toon))

## 2026.5.31 - 2026-05-31

### Added

- Non-blocking background search index refresh on mutations ([pm-3ju0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3ju0.toon))

### Changed

- Per-command code-splitting: lazy command-module imports drop the 943KB monolith + fast-glob from the read path ([pm-t57d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-t57d.toon))

### Fixed

- pm health ok:false from legacy unused 'index' required subdir ([pm-yf31](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yf31.toon))
- Calendar date math is UTC-only: ignores event.timezone and all-day semantics ([pm-0l88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0l88.toon))
- Fix per-type default_status config was silently ignored at create ([pm-y0gl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-y0gl.toon))
- Fix slow/oversized local vector snapshot and mislabeled search fallback ([pm-f58e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-f58e.toon))
- Fix Windows npm command resolution for extension package installs ([pm-arax](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-arax.toon))

### Other

- Make MCP status enum + shell completion runtime-resolved from schema (not hardcoded) ([pm-jtdc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jtdc.toon))
- Defer eager per-command startup work: completion flag-strings, MCP tool schema build, telemetry flush spawn ([pm-3mal](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3mal.toon))
- Calendar view/format did-you-mean + dependency and type-safety cleanup ([pm-5oxq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5oxq.toon))
- 2026-05-30 package SDK dogfood audit and startup telemetry performance pass ([pm-qmx3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qmx3.toon))

## 2026.5.30 - 2026-05-30

### Added

- Semantic index not auto-refreshed on mutation: create then pm search --semantic misses the new item (stale index) ([pm-bpaj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bpaj.toon))
- Reduce ESM module-resolution startup overhead (~85ms) via core bundling ([pm-ss1d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ss1d.toon))

### Fixed

- create rejects common type synonyms (Bug/bug, Change/change) instead of mapping to Issue/Chore ([pm-4d1b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4d1b.toon))
- Suggestion-only command aliases (show/comment/note/view) still hard-fail as nonexistent_command instead of executing ([pm-7by2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7by2.toon))
- Calendar positional-date and impossible-deadline UX: pm calendar 2026-06-15 hard-errors; --deadline 2026-02-30 silently rolls to Mar 2 ([pm-wr74](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wr74.toon))
- Split metadata cache into light + collections tiers to cut list hot-path JSON parse ([pm-jd3v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jd3v.toon))
- create's schedule-less calendar hint suggests rejected --event pipe form (accepts CSV) — blocks agents ([pm-8c2s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8c2s.toon))
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

- pm update doesn't accept --expected/--actual aliases that pm close accepts ([pm-1lws](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1lws.toon))
- MCP pm_create/pm_update crashed with 'raw.trim is not a function' when priority was sent as a JSON number ([pm-9r7z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9r7z.toon))
- pm comments/notes/learnings --add HTML-escapes angle brackets in stored text ([pm-ydkl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ydkl.toon))

## 2026.5.28 - 2026-05-28

### Fixed

- Minor UX/correctness: test --add wording, dep-kind vocab, same-command did-you-mean, plan materialize, close inline resolution, scaffold defineExtension ([pm-fl0c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-fl0c.toon))
- Agent-UX footguns: create-type silent mistype + token-bloat in validate/search output ([pm-edge](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-edge.toon))

## 2026.5.27 - 2026-05-27

### Added

- Cut list/search latency: skip 4.9MB cache rewrite + drop bodies + onRead short-circuit ([pm-4r5t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4r5t.toon))
- Bundle CLI with esbuild for sub-200ms startup ([pm-gt82](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gt82.toon))
- Add --no-changed-fields flag and compact MCP mutation output to drop the redundant changed_fields array ([pm-ch59](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ch59.toon))
- Add pm config set positional value form and shorten the invalid config-key error ([pm-mf4j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mf4j.toon))

### Changed

- Split large command files exceeding 2000 LOC ([pm-mbdu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mbdu.toon))
- Deduplicate item/metadata to record widening casts behind a shared toItemRecord helper ([pm-p5if](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p5if.toon))

### Fixed

- pm health takes 8s and reports ok:false due to blocking telemetry flush to unreachable endpoint ([pm-1lgy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1lgy.toon))
- Calendar: improve positional view UX (PM-CLI-Z Sentry) ([pm-nb68](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nb68.toon))
- Improve unknown-option recovery with nearest, abbreviated, and cross-command flag suggestions plus list --sort aliases ([pm-8nyc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8nyc.toon))
- Repeated loose-mapped --tag flags silently keep only the last value (agent-unfriendly) ([pm-cf1u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cf1u.toon))
- Address pre-existing extension/SDK issues surfaced by PR \#69 review (CodeRabbit) ([pm-ll50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ll50.toon))
- Surface extension command handler error messages instead of opaque extension_command_handler_failed code ([pm-zwl7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zwl7.toon))
- Fix Auto Release failure: build dist before pm-changelog generation runs ([pm-yf8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yf8t.toon))
- Handle concurrent project package installs without EEXIST ([pm-hw6z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hw6z.toon))
- pm-changelog generator silently drops items the bundled @unbrained/pm-cli SDK cannot read ([pm-hybj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hybj.toon))

### Security

- Latest CLI quality, SDK, telemetry, search, and calendar remediation ([pm-rnpb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rnpb.toon))
- Harden extension install against path traversal and fill missing health/validate MCP schema props ([pm-qhu4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qhu4.toon))
- Add audited history-stream redaction command ([pm-xk39](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xk39.toon))

### Other

- Manual real-world E2E dogfood of full pm CLI surface (2026-05-27) ([pm-gqx7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gqx7.toon))
- Calendar + SDK + vector-search + docs review (2026-05-27) ([pm-a0w4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-a0w4.toon))
- Code-quality & dead/duplicate code audit (2026-05-27) ([pm-jvbt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jvbt.toon))
- Keep large modules maintainable via barrel re-export splits + explicit uncovered allowlist ([pm-3cbk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-3cbk.toon))
- CI/CD + test-suite performance: in-process CLI runner and dedupe redundant matrix legs ([pm-7rlp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7rlp.toon))
- Bump @sentry/node 10.53.1 to 10.54.0 ([pm-0g2p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0g2p.toon))
- Dedupe history-redact + history-repair lock+ownership scaffolding ([pm-kbm9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-kbm9.toon))
- Agent-UX combined PR: compact mutation output (pm-ch59) + smarter unknown-flag recovery (pm-8nyc) ([pm-70mi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-70mi.toon))
- Harden read-then-lock window uniformly across history-redact/restore/history-repair ([pm-uer0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-uer0.toon))
- Create native Codex plugin for pm CLI ([pm-0c9q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0c9q.toon))
- Unify plugin/MCP naming: pm-cli-claude→pm-claude, pm-cli-codex→pm-codex, pm-cli-native MCP→pm-mcp, packages @unbrained/pm-package-X→@unbrained/pm-X ([pm-ash0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ash0.toon))
- Dogfood 2026-05-20 low-severity CLI polish backlog (config UX, init verbosity, help alias bloat, default-safety, doc/validator drift) ([pm-5k2w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5k2w.toon))
- Docs hygiene: stop shipping PRD.md in npm package, dedupe PRD<-\>docs, slim CHANGELOG, reconcile marketplace.json ([pm-rjgh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-rjgh.toon))
- Single-source extension capability and policy-surface contract lists ([pm-w98k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-w98k.toon))
- Single-source Codex plugin docs tool surface ([pm-d97r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-d97r.toon))
- Single-source extension governance policy defaults ([pm-axd1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-axd1.toon))
- Single-source guide-shell routing snippets across docs ([pm-48vd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-48vd.toon))
- Single-source Plan workflow examples across plugin docs ([pm-3y56](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-3y56.toon))
- Single-source extension manifest and policy examples in docs ([pm-2awd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2awd.toon))
- Single-source Claude plugin capability inventory docs ([pm-0d0q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0d0q.toon))
- Deduplicate Beads and Todos package adapter runtimes ([pm-ybfj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ybfj.toon))
- Deduplicate bundled package runtime option parsing helpers ([pm-y5u0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-y5u0.toon))
- Code dedup: extract shared CLI parser blocks and consolidate item-record casts ([pm-why9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-why9.toon))
- Deduplicate files/docs linked-resource command implementations ([pm-jzf4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jzf4.toon))
- Deduplicate Claude and Codex plugin MCP wrappers and smoke flows ([pm-js0r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-js0r.toon))
- Extract shared legacy settings test fixtures ([pm-ibyi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ibyi.toon))
- Extract reusable semantic HTTP mock fixtures ([pm-gvk2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gvk2.toon))
- Deduplicate beads/todos index.ts package-runtime loader (install-safe mechanism needed) ([pm-wwa7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wwa7.toon))
- Generate full historical CHANGELOG.md through pm-changelog ([pm-afl9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-afl9.toon))
- Verify and repair pm-changelog-generated main CHANGELOG release alignment ([pm-5baq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5baq.toon))

## 2026.5.24 - 2026-05-24

### Added

- Default-safety policy for destructive pm commands (gc keeps delete-by-default; add pm delete --dry-run) ([pm-tobi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-tobi.toon))
- pm schema add-type CLI + invalid-type error hint (pm-e1va) ([pm-fy8o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-fy8o.toon))
- Config-driven custom item types: wire schema/types.json into runtime schema ([pm-e1va](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e1va.toon))

### Changed

- Remove dead code: command-aware.ts module, 5 orphaned exported functions, unused undici dependency ([pm-b7do](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-b7do.toon))

### Fixed

- Recover 16 unreadable TOON item files: strict decoder mis-parses bracketed tokens followed by a colon inside quoted text fields ([pm-iqgj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-iqgj.toon))
- pm-changelog extension fails on large tracker JSON ([pm-bu50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bu50.toon))
- Linked test sandbox cleanup can fail with ENOTEMPTY ([pm-u43m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u43m.toon))
- pm update --blocked-by does not create a pm deps graph edge ([pm-kyd6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kyd6.toon))
- Auto daily release silently skips releasable commits when CHANGELOG \[Unreleased\] is empty ([pm-ot8r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ot8r.toon))
- pm update/create --test shares the B2 silent key-corruption (no cmd alias, no unknown-key rejection) ([pm-swie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-swie.toon))
- Calendar: pm cal <view\> --date crashes (positional view + any flag) ([pm-l292](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-l292.toon))
- Agent UX: pm update --status closed, explicit semantic/hybrid search, and pm create <type\> <title\> must never block agents ([pm-j1v7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-j1v7.toon))
- pm plan: materialize creates dependency cycle; decision/discovery/validation flag mismatch; --steps all unsupported ([pm-6blp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6blp.toon))

### Removed

- Deduplicate item-store mutation and delete lifecycle setup ([pm-za3c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-za3c.toon))
- CLI ergonomics polish: concise init, help alias collapse, named priorities, package install hints, starter templates, delete dry-run ([pm-fuat](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-fuat.toon))

### Security

- Deduplicate path containment helpers across package and extension code ([pm-dpzc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dpzc.toon))
- Update npm dependencies: minor version bumps (sentry/cli, toon, node types, vitest, tsx) ([pm-a2g6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-a2g6.toon))

### Other

- Release @unbrained/pm-cli 2026.5.24 ([pm-jpfc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-jpfc.toon))
- Deduplicate recurrence weekday ordering helper ([pm-max1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-max1.toon))
- Deduplicate item-type definition normalization across settings and registry ([pm-v798](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-v798.toon))
- Deduplicate runtime terminal-status checks across query commands ([pm-i04b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-i04b.toon))
- Centralize audit ownership-conflict guidance ([pm-ols6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ols6.toon))
- Deduplicate comments, notes, and learnings command stacks ([pm-9y8q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-9y8q.toon))
- Deduplicate mutation author fallback resolution across commands ([pm-xh0y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-xh0y.toon))
- Deduplicate health and validate history-drift checks ([pm-qsk8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-qsk8.toon))
- Deduplicate lazy dynamic-import cache boilerplate in CLI registration ([pm-c98b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-c98b.toon))
- Deduplicate front-matter key-order contract literals in tests ([pm-8fx3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8fx3.toon))
- Install and validate pm-changelog package ([pm-7811](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7811.toon))
- Extract shared direct CLI spawn helper for integration tests ([pm-401l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-401l.toon))
- Extract shared JSON error-envelope test assertions ([pm-alqo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-alqo.toon))
- Extract shared temporary-directory lifecycle helpers for tests ([pm-7tug](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7tug.toon))
- Extract shared test item factories for command specs ([pm-eltf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eltf.toon))
- Extract shared extension fixture writer for tests ([pm-j15d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-j15d.toon))
- Deduplicate templates package runtime and legacy command implementation ([pm-ypqp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ypqp.toon))
- Dogfood 2026-05-21 follow-ups: test --add key validation, semantic-fallback labeling, close active-children info, stale blocker on close ([pm-fu5d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fu5d.toon))
- Calendar agent ergonomics: equal start/end rejected; schedule-less Event items invisible ([pm-uzmf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-uzmf.toon))
- history-repair command + legacy drift cleanup + replay dedup ([pm-c3dx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-c3dx.toon))
- Session 2026-05-23: agent-UX + deps-graph integrity batch (multi-agent) ([pm-uz25](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-uz25.toon))
- Deduplicate history, restore, and redaction replay helpers ([pm-pjs5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-pjs5.toon))
- pm validate: ok:false on warn-only checks + dumps every item ID per field ([pm-1nht](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1nht.toon))

## 2026.5.23 - 2026-05-23

### Added

- pm health output stays large even with --brief/--skip flags; add a true one-line summary mode ([pm-nbht](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nbht.toon))
- Reduce default verbosity of pm activity/history CLI output and add a compact mode to pm history ([pm-3pbs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3pbs.toon))

### Fixed

- Audited history-repair (re-anchor) command + clear legacy history drift so pm health is ok ([pm-85hm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-85hm.toon))
- pm create --blocked-by stores free-text metadata, not a dependency edge or blocked status (agent-confusing) ([pm-orrl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-orrl.toon))
- MCP pm_comments returns full comment history (no default limit) — token bloat on long-lived items ([pm-6vfg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6vfg.toon))
- Sentry PM-CLI-R/PM-CLI-S: undefined-status .trim and undefined-tags .join crashes (fixed in HEAD, mark resolvedInNextRelease) ([pm-d7us](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d7us.toon))
- MCP pm_run activity defaults to verbose raw history-patch dump (token waste for agents) ([pm-8jd3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8jd3.toon))
- Dogfood 2026-05-20: CLI/agent-UX consistency fixes (append text forms, scope errors, --list parity, command typo suggestions) ([pm-atsv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-atsv.toon))
- MCP pm_search defaults to full item bodies, blowing past agent token limits ([pm-qrxs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qrxs.toon))

### Security

- Harden secret-scan guardrail for GitHub token prefixes and local credential hygiene ([pm-h4zb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-h4zb.toon))

## 2026.5.18 - 2026-05-18

### Added

- Add pm plan list subcommand or did-you-mean to pm list --type Plan ([pm-zpa5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zpa5.toon))
- pm list should default to --brief (full output via --full) to halve token cost ([pm-b7sd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-b7sd.toon))
- Add agent-optimized pm plan command with linked dependencies ([pm-v7dj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v7dj.toon))
- Add built-in Plan item type and storage/search integration ([pm-jauk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jauk.toon))
- Drastically improve GitHub runner time and resource usage (free-tier only) ([pm-tzwy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tzwy.toon))
- Add pm init checks for AGENTS/CLAUDE pm workflow guidance ([pm-7t04](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7t04.toon))
- Add dependency mutation command for existing items ([pm-zdec](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-zdec.toon))
- Narrow contracts --command output by default and add projection modes ([pm-xlzl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xlzl.toon))
- Add dependency visualization command (pm deps) ([pm-x85o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-x85o.toon))
- Add extension project scaffold command or template ([pm-wsui](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-wsui.toon))
- Add governance normalize command with dry-run and apply modes ([pm-vi2v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-vi2v.toon))
- Add scoped audit override mode for pm update metadata mutations ([pm-umhv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-umhv.toon))
- Pi wrapper action parity: add completion action ([pm-oqe0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oqe0.toon))
- Add files discovery subcommand for referenced paths ([pm-n2ts](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-n2ts.toon))
- Implement governance query controls from 2026-04-06 issue report ([pm-jqgc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jqgc.toon))
- Add definition-of-done config baseline ([pm-jdt8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jdt8.toon))
- Add dependency-cycle diagnostics to pm validate lifecycle checks ([pm-i4ef](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i4ef.toon))
- M5 roadmap: Pi agent extension advanced ergonomics ([pm-hbc1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hbc1.toon))
- Add list-draft command parity for draft status ([pm-ex1y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ex1y.toon))
- Add calendar --full-period option and clarify period boundary wording ([pm-euh6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-euh6.toon))
- Issue2 Feature: Run-level env controls and shared-host-safe flags ([pm-ec5o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ec5o.toon))
- Extend pm validate with low-signal metadata quality checks ([pm-dw5s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dw5s.toon))
- Comments shorthand compatibility and docs parity ([pm-cvwi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cvwi.toon))
- Add deterministic linked-test replacement mode for update test mutations ([pm-bjpo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bjpo.toon))
- Stability regressions and update/file UX guidance hardening ([pm-ap8l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ap8l.toon))
- Add package-first command aliases and pm install ([pm-9x1c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9x1c.toon))
- Extend SDK contracts and Pi wrapper for extension lifecycle actions ([pm-9ajy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-9ajy.toon))
- Add reusable item templates for pm create ([pm-780f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-780f.toon))
- Add lazy dynamic tag completion with optional eager expansion ([pm-6qnu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6qnu.toon))
- Add extension adopt workflow for unmanaged extensions ([pm-5dia](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5dia.toon))
- Wave 8/9: add test-all limit/offset blast-radius controls ([pm-5a4f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5a4f.toon))
- Add glob-based linked artifact additions for files/docs ([pm-3eu2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3eu2.toon))
- Health vectorization status and targeted refresh ([pm-3ebr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3ebr.toon))
- Extended schema fields v1.1 - parent, reviewer, risk, sprint, release ([pm-2p6q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2p6q.toon))
- Health optional directory strictness and compatibility ([pm-2i0i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2i0i.toon))
- Repo restructure and module boundaries ([pm-2c8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2c8.toon))
- Agent integration and docs hardening for calendar/reminders ([pm-122q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-122q.toon))
- Add activity filtering and stream mode for large program automation ([pm-0g7a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0g7a.toon))
- Calendar parity integrations and release hardening ([pm-02gd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-02gd.toon))
- pm claim --if-available (skip when held) — reduce 533 ownership_conflict events ([pm-d4bo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-d4bo.toon))
- pm get/show: did-you-mean suggestions for unknown IDs (telemetry: 233 hits/30d) ([pm-99x5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-99x5.toon))
- pm init footer + bundle calendar so cal/templates are discoverable ([pm-8wwl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8wwl.toon))
- pm update with no fields should noop-succeed, not fail (telemetry: 128 hits/30d) ([pm-7cup](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7cup.toon))
- Auto-route pm update --status closed --close-reason to pm close (telemetry: 248 hits/30d) ([pm-12ib](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-12ib.toon))
- Add --with-packages flag to pm init for one-shot package install ([pm-hosd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hosd.toon))

### Changed

- Implement atomic dependency replacement mode for pm update ([pm-tixl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tixl.toon))
- Update completion and Pi wrapper for calendar/reminder support ([pm-qze9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qze9.toon))
- Align update body contracts completion and regressions ([pm-ha5a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ha5a.toon))
- Task: implement update close_reason flag and reopen auto-clear ([pm-g8jp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g8jp.toon))
- Update completion and Pi wrapper for event recurrence flags ([pm-5hbj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5hbj.toon))
- Pi wrapper all-fields create/update parity ([pm-096j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-096j.toon))
- M1: Core command set init create get update append delete claim release close ([pm-06t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-06t.toon))

### Fixed

- Suppress benign extension_service_override_collision when calendar+guide-shell both bundled ([pm-5u9z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5u9z.toon))
- pm test --add causes immediate history drift via null timeout_seconds ([pm-er4q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-er4q.toon))
- Clean project linked-file validation hygiene ([pm-xz1p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xz1p.toon))
- CI: cache .agents/pm/search/lancedb + sentry release cache ([pm-n28v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-n28v.toon))
- CI: cache vitest/.cache + tsbuildinfo for incremental builds + faster tests ([pm-1pah](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1pah.toon))
- CI: skip non-source jobs on docs-only changes ([pm-iv1u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-iv1u.toon))
- CI: split quality+smoke gates into a parallel job, share dist via artifact ([pm-27yz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-27yz.toon))
- Add regression coverage for pm init agent guidance workflows ([pm-0nia](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0nia.toon))
- Fix validate --check-files false-positive on linked project paths ([pm-m9tv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m9tv.toon))
- Align templates-save Pi contracts with supported CLI flags ([pm-eg0a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eg0a.toon))
- Fix pm test run exit semantics for failed linked tests ([pm-c1bn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-c1bn.toon))
- MCP pm_context crashes on caller-supplied projection flags (compact/brief/fields/includeBody) ([pm-xy02](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xy02.toon))
- pm install <invalid\> lacks did-you-mean for built-in aliases ([pm-uuee](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-uuee.toon))
- pm validate after fresh create is scary — downgrade default profile noise ([pm-tylj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tylj.toon))
- auto-release.yml workflow_dispatch silently overrides explicit push=false to true ([pm-qa2h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qa2h.toon))
- pm contracts default returns 286 KB / 9612 lines — token catastrophe for agents ([pm-p8j6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p8j6.toon))
- pm install exits 0 on error (CRITICAL agent-blocker) ([pm-naiv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-naiv.toon))
- CLI silently corrupts --tags '\["a","b"\]' JSON-array input (agent-unfriendly) ([pm-klqo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-klqo.toon))
- pm bare command silent exit 0 — no help shown ([pm-8rj2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8rj2.toon))
- CI: smaller matrix on PRs, full matrix on main push only ([pm-lkd7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-lkd7.toon))
- Investigate validate/health telemetry classification (71-74% failure rate) ([pm-bzx3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bzx3.toon))
- Telemetry queue tmp file orphan cleanup (83MB stale) ([pm-nhka](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nhka.toon))
- Stop listing provided --flag as missing in error recovery bundle ([pm-ixi1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ixi1.toon))
- Default project scope for files/docs/tests and simplify scope UX ([pm-ntnf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ntnf.toon))
- Fix CSV status filter and multi-status support in pm list ([pm-ziv0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ziv0.toon))
- CI: combine pnpm test + pnpm test:coverage into single coverage run ([pm-hpjd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hpjd.toon))
- MCP pm_list defaults to compact projection for agents ([pm-2cqx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2cqx.toon))
- Fix TOON array-of-objects continuation lines double-indent ([pm-ps85](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ps85.toon))
- MCP pm_update --comment string crashes with 'values.map is not a function' ([pm-qeu1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qeu1.toon))
- Cache item body in metadata cache for fast keyword search ([pm-jw36](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-jw36.toon))
- pm install writes absolute-home-path into tracked .managed-extensions.json ([pm-u83w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-u83w.toon))
- Embedding timeout UX: improve ollama feedback for PM-CLI-A/9 ([pm-ibp7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ibp7.toon))
- Perf: pm health takes 2.5s due to vectorization check ([pm-tibg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tibg.toon))
- Sentry extension errors: cannot find module and activate failures ([pm-p7av](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p7av.toon))
- Fix: ENOENT lstat in extension path operations ([pm-bh13](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bh13.toon))
- Fix: localeCompare on undefined in sort comparators ([pm-b9y1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b9y1.toon))
- Accept positional title argument in pm create ([pm-7vm9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7vm9.toon))

### Removed

- Remove session-based ownership model ([pm-5rh2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5rh2.toon))
- Implement pm delete command ([pm-4yl0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4yl0.toon))

### Security

- 2026-05-02 Full PM CLI Audit: Build Fix, Security, Performance, Telemetry ([pm-nnhi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-nnhi.toon))

### Other

- Opt CI JavaScript actions into Node 24 runtime ([pm-1lef](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1lef.toon))
- Accept positional title for pm plan create like pm create does ([pm-qbts](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qbts.toon))
- Accept pm init --yes alias for --defaults ([pm-lwbr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lwbr.toon))
- Dogfood + remediation session 13 (2026-05-17) ([pm-vmeo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/plans/pm-vmeo.toon))
- Expose Plan workflow in SDK, MCP, plugins, docs, and dogfood ([pm-aqat](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-aqat.toon))
- Implement pm plan command family for agent harness workflows ([pm-ze5g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ze5g.toon))
- Document pm init agent guidance context workflow ([pm-1265](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1265.toon))
- Expose agent guidance init option in settings, contracts, help, and config ([pm-b8rf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b8rf.toon))
- Wire pm init approval flow and declined guidance persistence ([pm-8rjn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8rjn.toon))
- Build idempotent AGENTS/CLAUDE pm guidance detector and writer ([pm-g2nd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g2nd.toon))
- Implement Issue3 files stable-append mutation mode ([pm-xv39](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xv39.toon))
- GC safety ergonomics: dry-run and scoped cleanup ([pm-xrm7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xrm7.toon))
- Decouple optional package actions from static SDK contracts ([pm-wxxv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wxxv.toon))
- Issue3 Task: Contracts Pi docs and tests parity ([pm-wvr0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wvr0.toon))
- Implement comments-audit command with filters/latest ([pm-w1j3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-w1j3.toon))
- Implement PM-context parity mode and mismatch metadata for linked tests ([pm-vrsn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vrsn.toon))
- Implement Issue4 create progressive policy mode ([pm-v7aw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-v7aw.toon))
- Implement health optional-directory defaults and strict mode ([pm-t7xl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t7xl.toon))
- Design full pm package manifest and resource model ([pm-t5ud](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t5ud.toon))
- Implement extension help and contracts runtime integration ([pm-sucq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sucq.toon))
- Configurable item types and required-option UX ([pm-r15d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-r15d.toon))
- M4: Keyword indexing and search command ([pm-pmd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pmd.toon))
- M2: RFC6902 patch generation per mutation ([pm-p9z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p9z.toon))
- Implement background start paths and test-runs command surface ([pm-ormq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ormq.toon))
- PM CLI 2026-04-06 audit findings remediation ([pm-o7be](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-o7be.toon))
- Pi wrapper numeric scalar flag parity ([pm-ni7x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ni7x.toon))
- Implement Issue1 validate scan-mode and candidate totals ([pm-kshe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kshe.toon))
- Implement pm validate and --validate-close behavior ([pm-k6ml](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k6ml.toon))
- Implement list parent filter and get guidance updates ([pm-jlsh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jlsh.toon))
- M5: Built-in Pi tool wrapper extension ([pm-igv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-igv.toon))
- Implement list offset pagination and JSON stream mode ([pm-ice4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ice4.toon))
- Implement extension doctor summary/deep diagnostics command ([pm-hjrr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hjrr.toon))
- Implement and verify pm context command ([pm-f583](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f583.toon))
- Pi wrapper workflow preset: close-task ([pm-ewoq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ewoq.toon))
- Pi wrapper fallback path hardening ([pm-e6qb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e6qb.toon))
- Full-scope SDK and extension platform upgrade for app/CI integrations ([pm-dhie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dhie.toon))
- Wave 8/9: non-interactive help paging safeguards and --no-pager ([pm-crk9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-crk9.toon))
- Implement pm notes and pm learnings command stack ([pm-c465](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-c465.toon))
- M5 roadmap: Pi tool wrapper packaging/distribution polish ([pm-bdz5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bdz5.toon))
- Execute Agent-First CLI UX v3 implementation ([pm-b21u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b21u.toon))
- Implement fail-on-skipped policy and linked-test assertions ([pm-au2z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-au2z.toon))
- External follow-up: reduce tracked-all orphaned noise from PM internals ([pm-a228](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a228.toon))
- Implement Issue5 comments audit append path ([pm-8k10](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8k10.toon))
- Docs, contracts, and verification sweep for external audit follow-up ([pm-64f1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-64f1.toon))
- Implement config list/export command actions ([pm-5lmj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5lmj.toon))
- Implement pm dedupe-audit command modes and merge suggestions ([pm-4n1a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4n1a.toon))
- Sync contracts/completion/Pi for background test-run surfaces ([pm-4moz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4moz.toon))
- M4 follow-up: exact-title lexical boost for deterministic search ranking ([pm-4iga](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4iga.toon))
- Issue3 Task: Default-on validate command reference check ([pm-2ajr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2ajr.toon))
- Implement search argument and projection mode changes ([pm-0nxf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0nxf.toon))
- Smoke test after audit ([pm-xmsn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xmsn.toon))
- Implement pm guide docs and skills modernization ([pm-4z9m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4z9m.toon))
- 2026-05-03 latest PM CLI dogfood audit ([pm-jrjt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-jrjt.toon))
- Merge Dependabot PRs: dev+prod deps and pnpm/action-setup ([pm-2723](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2723.toon))
- Release @unbrained/pm-cli after 2026.5.12 ([pm-dc5d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dc5d.toon))

## 2026.5.14 - 2026-05-14

### Added

- Publish package gallery and marketplace metadata ([pm-2b3l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2b3l.toon))
- Add reusable package-first temp-project dogfood script ([pm-8l7d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8l7d.toon))

### Changed

- Extract guide and completion UX into installable package ([pm-zjuv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zjuv.toon))
- Extract governance audit surfaces into installable package ([pm-ixt3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ixt3.toon))
- Define linked test runner package boundary ([pm-7xk5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7xk5.toon))
- Extract advanced search and vectorization into installable pm package ([pm-2rj1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2rj1.toon))
- Extract calendar UX into installable pm package ([pm-pznn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pznn.toon))
- Extract create templates into installable pm package ([pm-2fgn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2fgn.toon))

### Fixed

- Sync package JS runtimes to public SDK surface ([pm-2t78](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-2t78.toon))
- Hybrid semantic reindex should emit bounded progress and deterministic JSON completion ([pm-6zqq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6zqq.toon))
- Expose runtime command-path state in extension explore ([pm-5mua](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5mua.toon))

### Other

- Simplify command inputs for setup-agnostic agent workflows ([pm-ej01](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ej01.toon))
- Expose package runtime helpers through public SDK ([pm-hkql](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hkql.toon))
- Migrate extension terminology to package-first docs and UX ([pm-lwun](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-lwun.toon))

## 2026.5.12 - 2026-05-12

### Added

- Generalize pm package resources for project-management extensions ([pm-su6i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-su6i.toon))

### Fixed

- Suppress linked-test sandbox ENOENT seed races ([pm-kk4t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-kk4t.toon))

### Other

- Run package-first CLI and SDK temp-project E2E ([pm-gy6w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gy6w.toon))
- Implement pm upgrade for CLI, SDK, and packages ([pm-bob2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bob2.toon))
- Extract bundled import/export customizations into installable pm packages ([pm-hxp2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hxp2.toon))
- M5: Built-in todos import export extension ([pm-3s0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3s0.toon))
- M5: Built-in beads import extension ([pm-odt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-odt.toon))
- Classify barebone core boundary and package migration matrix ([pm-c933](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-c933.toon))
- Stop tracking runtime metadata cache ([pm-4det](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4det.toon))

## 2026.5.11 - 2026-05-11

### Fixed

- Profile and optimize command startup latency ([pm-m4ov](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-m4ov.toon))
- Fix Claude plugin smoke marketplace contract ([pm-sw92](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sw92.toon))

## 2026.5.10 - 2026-05-10

### Security

- 2026-05-09 latest-build full pm CLI dogfood audit and remediation ([pm-m35h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m35h.toon))

## 2026.5.6 - 2026-05-06

### Fixed

- GitHub \#21: document resilient global git-install recovery ([pm-drje](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-drje.toon))
- GitHub \#20: resilient mixed-frontmatter item-format migration ([pm-w5j7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-w5j7.toon))

### Other

- Release @unbrained/pm-cli after 2026.5.4 ([pm-0rjf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0rjf.toon))

## 2026.5.3-2 - 2026-05-04

### Other

- Release @unbrained/pm-cli after 2026.5.2 ([pm-0qv7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-0qv7.toon))

## 2026.5.3 - 2026-05-03

### Added

- Analyze persisted telemetry and add remote analysis skill ([pm-cakn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cakn.toon))
- Feature: Telemetry pipeline verified end-to-end ([pm-0kjv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0kjv.toon))

### Changed

- Code quality review - latest refactor surface ([pm-zk79](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zk79.toon))
- Code quality + architecture review with targeted tests ([pm-lvww](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lvww.toon))
- main.ts still has 4 extraction candidates (~1325 lines) ([pm-sh6o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sh6o.toon))
- Duplicated parseLimit/parsePriority/parseType across 8+ command files ([pm-hb8t](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hb8t.toon))

### Fixed

- Blocker: telemetry endpoint returning HTTP 521 ([pm-ut35](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ut35.toon))
- Validate UUID fields at telemetry ingestion boundary ([pm-vhdc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vhdc.toon))
- Fix Grafana RabbitMQ queue panel metric selector mismatch ([pm-r9ei](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-r9ei.toon))
- PmCliError events leaking to Sentry via captureConsoleIntegration ([pm-9iho](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9iho.toon))
- Code duplication: toErrorMessage and toNonEmptyString across 5+ files ([pm-540l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-540l.toon))
- UX: Telemetry shows 84 'No update flags provided' errors - improve guidance ([pm-sh4x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sh4x.toon))
- Project tracker validation hygiene warnings remain ([pm-e0b5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-e0b5.toon))

### Security

- Security/privacy leakage gate - redact host/IP/token from tracked files ([pm-m0fh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m0fh.toon))
- Pin GitHub Actions to immutable SHAs ([pm-hfny](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hfny.toon))
- Execute latest dogfood audit and targeted fixes ([pm-mm3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mm3h.toon))
- Enhance check-secrets.mjs with private IP detection rule ([pm-daft](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-daft.toon))
- Chore: 2026-05-02 Phase 3 Audit - IP scrub, dogfood, analysis tooling ([pm-2326](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2326.toon))
- Issue: Private IP address in committed pm task files ([pm-xk8b](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xk8b.toon))

### Other

- Telemetry + Sentry analysis and remediation ([pm-xwl6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xwl6.toon))
- Calendar + agent output audit ([pm-wyvu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wyvu.toon))
- SDK + extension platform audit and ergonomics ([pm-lvea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lvea.toon))
- Dogfood full E2E lifecycle in temp sandbox ([pm-g4zb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g4zb.toon))
- Dogfood lifecycle matrix in temp project ([pm-cu50](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cu50.toon))
- Search + Calendar + SDK deep validation ([pm-937o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-937o.toon))
- Search/vector/auto-indexing deep audit (critical path) ([pm-4u2e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4u2e.toon))
- 2026-05-03 Full PM CLI Re-Audit (Live Cycle) ([pm-476d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-476d.toon))
- CI/CD + telemetry/Sentry client re-audit ([pm-44hv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-44hv.toon))
- Live remote infra + Sentry SaaS analysis ([pm-2o82](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2o82.toon))
- CI/CD hardening sweep - workflows + release scripts ([pm-0kd4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0kd4.toon))
- Execute telemetry + observability rollout implementation ([pm-ny6y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ny6y.toon))
- Decision: Re-audit final verification and system health summary ([pm-tdo5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-tdo5.toon))
- 2026-05-02 Comprehensive PM CLI Audit (v2026.5.2) ([pm-5zkg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-5zkg.toon))
- Performance baseline: list-open reads all 636 items front-matter on every invocation ([pm-f6wr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-f6wr.toon))
- main.ts exceeds 5000+ lines - assess decomposition into per-command registration modules ([pm-6c3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6c3h.toon))
- Decision: v2026.5.2 Audit Results - System Healthy ([pm-dmam](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-dmam.toon))
- CI: make package test scripts sandbox-first ([pm-swja](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-swja.toon))
- Extract shared HTTP fetch/timeout/error patterns from providers.ts and vector-stores.ts ([pm-p0p1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-p0p1.toon))
- 2026-04-26 comprehensive dogfood audit stabilization ([pm-mb4n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mb4n.toon))
- 2026-05-01 Full PM CLI Dogfood Audit v2 ([pm-2eb3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-2eb3.toon))

## 2026.5.2 - 2026-05-02

### Added

- SDK: Export ItemFrontMatter and ItemDocument types ([pm-slul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-slul.toon))
- Add vector dimension mismatch warning counter to LanceDB queries ([pm-k213](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k213.toon))
- Performance: Parallelize listAllFrontMatter I/O ([pm-hiji](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-hiji.toon))
- Architecture: Decompose extension loader types ([pm-f9s0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-f9s0.toon))
- Performance: list/filter operations scan all 625+ item files on each invocation ([pm-cd2f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-cd2f.toon))
- Docs: Add practical SDK extension examples ([pm-7k9o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7k9o.toon))
- Code Quality: Extract shared primitives module ([pm-5na9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5na9.toon))
- Agent UX: Add --brief output mode and context suggestions ([pm-32si](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-32si.toon))
- Feature: Telemetry Pipeline Audit - Fully Operational ([pm-jkip](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-jkip.toon))
- Agent-optimized documentation structure ([pm-r9gu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-r9gu.toon))
- Feature: Core commands verified - all 10 types and lifecycle ([pm-qwe2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qwe2.toon))
- Feature: SDK & Extension System Audit - Comprehensive ([pm-qdha](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qdha.toon))
- Feature: Extensibility architecture verified - governance, custom types, agent UX ([pm-oe33](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oe33.toon))
- Feature: SDK exports complete with 78 public symbols ([pm-92s0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-92s0.toon))
- Feature: Core Commands Audit - All Passing ([pm-7kiy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7kiy.toon))
- Feature: Calendar Subsystem Audit - All Passing ([pm-7k60](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7k60.toon))
- Feature: Calendar fully functional with recurrence expansion ([pm-409c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-409c.toon))
- Audit latest CLI, SDK, calendar, and telemetry workflows ([pm-3fti](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-3fti.toon))
- Add --compact mode to pm activity for agent-friendly condensed output ([pm-ne67](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ne67.toon))

### Changed

- Update-many: improve error message when no mutation flags provided ([pm-twtu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-twtu.toon))

### Fixed

- Telemetry queue timeout: 21 events stuck with flush timeout ([pm-sgmb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-sgmb.toon))
- Telemetry: Fix queue bloat and move flush to background ([pm-sgko](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-sgko.toon))
- SDK: bundled extensions use internal imports instead of @unbrained/pm-cli/sdk ([pm-qfuq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qfuq.toon))
- Search: Fix cosine similarity with L2 normalization ([pm-h2pi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-h2pi.toon))
- Telemetry queue oversized-event pruning not applied during flush phase (regression) ([pm-on3q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-on3q.toon))
- Calendar --include scheduled alias missing (calendar summary uses 'scheduled' but filter requires 'events') ([pm-itb0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-itb0.toon))
- Fix integration test: health check list missing telemetry entry ([pm-hb6x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hb6x.toon))
- pm templates bare command shows empty output (should list templates) ([pm-dc2y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-dc2y.toon))
- pm files --add bare path fails with misleading error (scope implied required) ([pm-8r2r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8r2r.toon))
- Calendar: allow --full-period for agenda view or improve error message ([pm-8qpc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8qpc.toon))
- Templates command: document correct invocation syntax (positional vs --name) ([pm-6y6i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6y6i.toon))
- Priority --priority error message missing 0..4 range and semantic labels ([pm-1h7w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1h7w.toon))
- pm health ok:false for normal telemetry queue draining is non-actionable noise ([pm-gmnh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gmnh.toon))
- pm cal --include events\|scheduled expands recurring events without default cap ([pm-vg5h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-vg5h.toon))
- Calendar recurring event line has redundant double-title (item title repeated in event title field) ([pm-b1pd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-b1pd.toon))
- Issue: Telemetry queue bloat from oversized result_summary payloads ([pm-ntr0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ntr0.toon))

### Removed

- Remove 15 dead root-level facade re-export files ([pm-l9j6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l9j6.toon))

### Security

- 2026-05-02 Full PM CLI Audit Phase 2: Dead Code Removal, Security Enhancement, Sentry Optimization ([pm-kkmo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-kkmo.toon))
- Rewrite README and public documentation ([pm-1sb2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1sb2.toon))
- Documentation overhaul and public docs safety ([pm-3042](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-3042.toon))
- Pin release dependency ranges for Dependabot hygiene ([pm-q71q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-q71q.toon))

### Other

- Release @unbrained/pm-cli 2026.5.2 ([pm-5jw8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-5jw8.toon))
- 2026-05-02 Full Audit: All Systems Verified ([pm-ss8d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ss8d.toon))
- Lower Sentry tracesSampleRate from 1.0 to 0.2 for free plan quota ([pm-wvhs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wvhs.toon))
- 2026-05-01 Full PM CLI Audit Implementation ([pm-twpc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-twpc.toon))
- 2026-05-02 Comprehensive PM CLI Audit ([pm-rrjv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-rrjv.toon))
- Sentry CLI token needs broader scopes for issue analysis ([pm-q4jp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-q4jp.toon))
- Dead code: root-level facade re-export shims unused ([pm-nr8k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-nr8k.toon))
- Decision: 2026-05-02 Comprehensive Audit Results ([pm-mve5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-mve5.toon))
- Telemetry: Backfill legacy source_context ([pm-dqer](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dqer.toon))
- Telemetry: Create Grafana dashboard ([pm-6js7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6js7.toon))
- Docs: Create telemetry stack runbook ([pm-2lbp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2lbp.toon))
- Verify remote telemetry stack receives events and data flows to \[redacted_monitoring_ui\] ([pm-g8gj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g8gj.toon))
- Chore: Prune stuck telemetry queue entries ([pm-wrbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wrbo.toon))
- Epic: 2026-04-28 Full PM CLI Dogfood Audit ([pm-wg1d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-wg1d.toon))
- Make lifecycle validate patterns configurable ([pm-urxb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-urxb.toon))
- Decision: PM CLI audit confirms production readiness ([pm-unbq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-unbq.toon))
- SDK docs: document cli-contracts exports and extension capability requirements ([pm-qrxb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qrxb.toon))
- Decision: Cap telemetry result_summary payload size ([pm-q9yt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-q9yt.toon))
- Core commands audit: full CRUD lifecycle verified with all item types ([pm-ewxk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ewxk.toon))
- Calendar audit: all views verified working, reminders and deadlines render correctly ([pm-71sj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-71sj.toon))
- Extension system audit: install/manage/doctor/activate lifecycle fully working ([pm-3s52](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3s52.toon))
- Telemetry pipeline verified: all \[redacted_service_count\] services healthy, E2E event ingestion working ([pm-3akm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3akm.toon))
- Chore: Telemetry queue steady-state has 100 pending entries ([pm-2gmr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2gmr.toon))
- 2026-04-30 Full PM CLI Dogfood Audit ([pm-23me](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-23me.toon))

## 2026.5.1-2 - 2026-05-01

### Fixed

- Stabilize post-release cross-platform CI tests ([pm-7d3m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7d3m.toon))

### Other

- Release @unbrained/pm-cli after 2026.3.12 ([pm-x6ni](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-x6ni.toon))

## 2026.5.1 - 2026-05-01

### Added

- List command large-output ergonomics ([pm-a4z3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-a4z3.toon))
- Add opt-in runtime probe mode for extension manage parity ([pm-p0ij](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-p0ij.toon))
- Implement context command runtime and surfaces ([pm-iyqf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-iyqf.toon))
- Add pm version and source classification to telemetry payloads ([pm-3dd9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-3dd9.toon))
- Expand aggregate group-by to support priority, status, assignee, tags ([pm-bhhe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bhhe.toon))
- Add telemetry runtime diagnostics to pm health ([pm-300m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-300m.toon))
- Implement CLI telemetry consent and runtime pipeline ([pm-5v5w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5v5w.toon))
- 2026-04-25 full dogfood audit remediation wave ([pm-2hrt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2hrt.toon))
- List parent filtering and get recovery guidance ([pm-v7o7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v7o7.toon))
- Remove none token semantics across command surfaces ([pm-rl4e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-rl4e.toon))
- Search UX and projection controls ([pm-qb71](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qb71.toon))
- Add compact/full/fields search output controls with compact default ([pm-nrxm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nrxm.toon))
- Extension help and contracts runtime introspection ([pm-4bhw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4bhw.toon))
- Add --parent filter support for list and list-\* commands ([pm-08zg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-08zg.toon))
- Add governance batch-mutation mode with explicit ownership override planning ([pm-lwps](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-lwps.toon))
- Automate duplicate-cluster detection and canonical mapping report ([pm-7lum](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7lum.toon))
- Clarify ownership conflict guidance for force overrides ([pm-8sgf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8sgf.toon))
- Stdin and PTY fail-safe behavior ([pm-olxl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-olxl.toon))
- Sunset pm install command and migrate to extension manager installs ([pm-8a2s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8a2s.toon))
- Config key discovery and export actions ([pm-kslz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kslz.toon))
- Bulk comments audit query surface ([pm-ayyt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ayyt.toon))
- Add AGENTS rule to check existing pm items before creating new ones ([pm-o5uw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-o5uw.toon))
- External follow-up: add focused extension diagnostics triage summaries ([pm-doek](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-doek.toon))
- Help System Redesign Across All Commands ([pm-j162](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j162.toon))
- Add test-result tracking settings and config policy ([pm-z9k7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-z9k7.toon))
- Background test service parity and release verification ([pm-elsh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-elsh.toon))
- Background linked-test orchestration and run management ([pm-bi0z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bi0z.toon))
- Configurable test-result tracking on PM items ([pm-16f4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-16f4.toon))
- Add README badges and update CONTRIBUTING.md to reference docs/ ([pm-x4f9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-x4f9.toon))
- Add Node 25 to nightly CI and create docs/ architecture+extension guides ([pm-aa6w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-aa6w.toon))
- Add package.json npm metadata and GitHub community files ([pm-ixbk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-ixbk.toon))
- Add automated npm release workflow and Node 24 CI coverage ([pm-mwe8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mwe8.toon))
- Add files/docs repeated-add regressions and update flag guidance ([pm-e0ab](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-e0ab.toon))
- Add --ac alias for create acceptance criteria ([pm-vyqe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vyqe.toon))
- Add integration test for pm list active-only behavior ([pm-gus1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gus1.toon))
- Add issue-specific metadata fields to item schema and CLI ([pm-rs40](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rs40.toon))
- Add confidence metadata flag support for create/update ([pm-kpz5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kpz5.toon))
- Add med alias for risk flag values ([pm-7w60](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7w60.toon))
- Add snake_case aliases for create/update acceptance and estimate flags ([pm-mfza](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mfza.toon))
- Add --title and -t support for pm update ([pm-w1r6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-w1r6.toon))
- Add --ac alias parity for pm update acceptance criteria ([pm-3qrp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3qrp.toon))
- Add notes and learnings command parity ([pm-v1s1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-v1s1.toon))
- Add pm completion command for bash/zsh/fish shell completion ([pm-7hx6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7hx6.toon))
- Add history missing-stream policy setting and config support ([pm-8wnm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8wnm.toon))
- Add option-policy schema and registry resolution ([pm-gu1m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gu1m.toon))
- Add extension registration support for custom item types/options ([pm-37pj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-37pj.toon))
- Add advanced event filters and bounded recurrence controls ([pm-8kxm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8kxm.toon))
- Add create/update event and recurrence mutation flags ([pm-enar](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-enar.toon))
- Add event and recurrence schema normalization ([pm-f0v0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f0v0.toon))
- Add create/update reminder flags and mutation paths ([pm-ysgr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ysgr.toon))
- Add TOON migration tests docs and verification ([pm-ybpq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ybpq.toon))
- Add tests and completion coverage for include-body list flag ([pm-6e0p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6e0p.toon))
- Dedicated extension doctor diagnostics surface ([pm-gm9y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gm9y.toon))
- Strict skipped-test policy and linked-test assertion semantics ([pm-wtq6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-wtq6.toon))
- Issue3 Feature: Extract PM-id references from linked commands ([pm-bf54](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bf54.toon))
- Issue2 Feature: Per-linked-test env directives ([pm-dlvv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dlvv.toon))
- Enforce command-required linked tests at mutation time ([pm-44iu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-44iu.toon))
- Linked-test sandbox project/global extension parity ([pm-bkvx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-bkvx.toon))
- Issue5: comments audit append policy path ([pm-ahq1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ahq1.toon))
- Issue4: create strict vs progressive policy mode ([pm-431e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-431e.toon))
- Issue3: files add stable append diff mode ([pm-6jps](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-6jps.toon))
- Issue1: validate check-files full tracked scan mode ([pm-j371](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-j371.toon))
- Validation command and close-time metadata checks ([pm-gtdx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-gtdx.toon))
- Implement managed extension state and lifecycle health surfaces ([pm-grst](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-grst.toon))
- Implement extension source resolver and installer engine ([pm-2poj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-2poj.toon))
- Implement pm extension lifecycle command surface ([pm-7ghv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7ghv.toon))
- Implement agent-first help/schema/error surfaces ([pm-dqqa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-dqqa.toon))
- Feature: comments force guidance parity ([pm-7y8q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7y8q.toon))
- Feature: claim takeover on non-terminal items ([pm-w9w4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-w9w4.toon))
- Feature: update close_reason lifecycle integrity ([pm-m4vu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m4vu.toon))
- Support pm update body end-to-end ([pm-ghha](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ghha.toon))
- Phase 2 docs, migration guidance, and release verification ([pm-r9nf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-r9nf.toon))
- Phase 2 SDK v2 contracts with backward-compat adapters ([pm-0u1y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0u1y.toon))
- Phase 2 pluggable core service kernel ([pm-qlo0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qlo0.toon))
- Phase 2 preflight and lifecycle interception engine ([pm-977j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-977j.toon))
- Phase 2 parser and command-contract override engine ([pm-k1zw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-k1zw.toon))
- Implement missing-history stream policy and restore fallback ([pm-kb21](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-kb21.toon))
- Health history drift detection ([pm-7vr9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-7vr9.toon))
- Activate semantic defaults via local Ollama runtime detection ([pm-zvn2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zvn2.toon))
- Docs, Contracts, and Verification Hardening ([pm-i0iy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-i0iy.toon))
- Command-Aware Human Output Redesign ([pm-t2hj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-t2hj.toon))
- Structured Error Guidance and Diagnostics ([pm-frk8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-frk8.toon))
- Exit/output and subprocess runtime hardening ([pm-axlr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-axlr.toon))
- Implement flexible deadline/date parser behavior ([pm-lau3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-lau3.toon))
- Canonical status alias normalization across CLI surfaces ([pm-1r6p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-1r6p.toon))
- Compatibility docs and verification hardening ([pm-tob5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tob5.toon))
- Flexible parser and stdin ingestion foundation ([pm-e7fd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e7fd.toon))
- SDK publishing and stability contract ([pm-oga6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-oga6.toon))
- Full registration runtime wiring ([pm-zd6y](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-zd6y.toon))
- Core command-dispatch override engine ([pm-al0h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-al0h.toon))
- Policy-driven option controls for create/update ([pm-5bwo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5bwo.toon))
- Required-option guidance and docs parity ([pm-b3id](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-b3id.toon))
- Dynamic type integration across CLI, storage, and completion ([pm-277p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-277p.toon))
- Configurable item type registry (settings + extensions) ([pm-x2k0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-x2k0.toon))
- Calendar occurrence engine and advanced view filtering ([pm-8m6s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8m6s.toon))
- Event and recurrence schema with mutation contracts ([pm-0ab3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-0ab3.toon))
- Persistent reminder item fields and CLI mutation support ([pm-c877](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-c877.toon))
- Calendar command with markdown default and multi-view rendering ([pm-tuhf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-tuhf.toon))
- Command integration tests and docs for TOON storage ([pm-u919](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-u919.toon))
- Automatic migration and legacy format gate ([pm-z8bl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-z8bl.toon))
- Dual-format item codec and storage support ([pm-5cbm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-5cbm.toon))
- Add include-body support across list variants ([pm-ykib](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-ykib.toon))
- Governance sweep 2026-04-03 net-new remediation ([pm-r7t2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-r7t2.toon))
- Harden entry and add input resilience ([pm-nhgt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-nhgt.toon))
- Linked-test PM context parity controls and mismatch guardrails ([pm-8izv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-8izv.toon))
- Implement deterministic guard for ambiguous create log seeds ([pm-m3mf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-m3mf.toon))

### Changed

- Improve update-command close and audit-owner failure guidance from telemetry ([pm-syt7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-syt7.toon))
- Align update-many status mutation support with help/contracts ([pm-3cx8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3cx8.toon))
- Implement pm update-many with dry-run checkpoints and rollback ([pm-lf6s](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lf6s.toon))
- Implement explicit clear/unassigned semantics and remove none token behavior ([pm-d7id](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-d7id.toon))
- Update docs and changelog for six audit findings ([pm-9eaz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-9eaz.toon))
- Improve required option error/help guidance with examples ([pm-bzyr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bzyr.toon))
- Installer scripts and update path ([pm-tq1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tq1.toon))
- Release-readiness guard for update help/contract parity ([pm-cujj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cujj.toon))
- T5: Update docs for terminal compatibility guarantees ([pm-qkva](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qkva.toon))
- T2: Refactor CLI error exits to graceful exitCode flow ([pm-1119](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1119.toon))
- Promote strategic metadata flags into canonical create/update contract ([pm-phob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-phob.toon))
- Release readiness refactor ([pm-ote](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-ote.toon))
- Update linked-test regressions docs and verification evidence ([pm-dk0a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dk0a.toon))
- Document update body support and ship verification evidence ([pm-ipm8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ipm8.toon))
- Wire update body runtime mutation path ([pm-eszd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eszd.toon))
- Phase 2: update extension architecture and migration docs ([pm-4epk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4epk.toon))
- Update docs and release evidence for default Ollama semantic behavior ([pm-ptu0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ptu0.toon))
- Error2: Refactor commander usage mapping and dedupe error output ([pm-eonv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eonv.toon))
- Parser update: support +m and flexible date strings ([pm-y8a8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-y8a8.toon))
- C3: Update docs and release notes for comments UX ([pm-bx5r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bx5r.toon))
- Update docs and verify status alias release readiness ([pm-posc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-posc.toon))
- Enforce option policies in create/update and help errors ([pm-co62](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-co62.toon))
- Update docs and finalize calendar/reminder release changes ([pm-2v01](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2v01.toon))
- Update body backfill normalization parity ([pm-ihfm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-ihfm.toon))
- Publish governance refactor report (2026-04-04) ([pm-2r70](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2r70.toon))

### Fixed

- Auto-migrate previous-version trackers on first mutation ([pm-yvwt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-yvwt.toon))
- Context blocked-fallback test uses date-sensitive default deadline ([pm-0xhj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0xhj.toon))
- SDK starter example leaves extension health warning ([pm-mwiz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mwiz.toon))
- Implement local telemetry queue retention_days TTL cleanup ([pm-pxx0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pxx0.toon))
- Clarify or harden SDK import resolution for local extension installs ([pm-1etl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-1etl.toon))
- Investigate search command latency from persisted telemetry ([pm-bhmu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bhmu.toon))
- Align default item types with Decision tracking guidance ([pm-mpmv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-mpmv.toon))
- Strengthen SDK typing for extension registration contracts ([pm-bqg4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bqg4.toon))
- Enforce telemetry capture_level setting in runtime event collection ([pm-gusd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gusd.toon))
- Clarify strict create empty repeatable semantics ([pm-k8i0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-k8i0.toon))
- Reject undefined placeholder IDs in parent/dependency inputs ([pm-g9yi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-g9yi.toon))
- Fix parser overrides for core commands without positional args ([pm-7jkm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-7jkm.toon))
- Fix LanceDB vector dimension mismatch blocking default search ([pm-oyt8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-oyt8.toon))
- Allow unquoted multi-word search queries ([pm-v6ob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v6ob.toon))
- Replace invalid-id echo in get not-found guidance ([pm-opbo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-opbo.toon))
- Include active extension commands/actions in contracts output ([pm-nnfc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-nnfc.toon))
- Expose extension command schema details in runtime help ([pm-ek2h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ek2h.toon))
- Fix Beads Import Lossiness ([pm-axl0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-axl0.toon))
- Release-readiness contract audit and next fix (2026-03-06 run 5) ([pm-x89f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-x89f.toon))
- Release-readiness contract audit and next fix (2026-03-06 run 4) ([pm-2joy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2joy.toon))
- Release-readiness contract audit and next fix (2026-03-06 run 3) ([pm-eamp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eamp.toon))
- Release-readiness contract audit and next fix (2026-03-06 run) ([pm-qkj9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-qkj9.toon))
- Release readiness contract audit and next fix ([pm-oadl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-oadl.toon))
- Deduplicate test-all linked test execution across items ([pm-v6e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v6e.toon))
- Fix sandbox runner passthrough for targeted test commands ([pm-2rl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2rl.toon))
- T4: Add terminal compatibility regression coverage ([pm-gh7d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gh7d.toon))
- Terminal compatibility regression suite and docs parity ([pm-t6f7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-t6f7.toon))
- Linked-test PM command context can drift from workspace dataset ([pm-6pij](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-6pij.toon))
- Phase 2: parser override regression and docs coverage ([pm-6024](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6024.toon))
- Add regression coverage for Ollama-backed semantic defaults ([pm-9k33](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9k33.toon))
- Test1: Expand regression coverage for help/error/output UX ([pm-jfpf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jfpf.toon))
- Cross-command regression verification for date parsing expansion ([pm-x6l7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x6l7.toon))
- C2: Add comments shorthand regression coverage ([pm-k0mr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k0mr.toon))
- Add status alias regression tests ([pm-0kga](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0kga.toon))
- Document resilient input formats and lock regression coverage ([pm-s9hl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-s9hl.toon))
- E1: Expand override and no-extension regression matrix ([pm-5chf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5chf.toon))
- Ship regression tests docs and verification evidence ([pm-r9dy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r9dy.toon))
- Expand recurrence regression and runtime contract tests ([pm-5xih](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5xih.toon))
- Remove TOON front_matter wrapper from item files ([pm-h3tp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h3tp.toon))
- Expand regression and release-readiness tests for calendar/reminders ([pm-tyq3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tyq3.toon))
- Fix cross-platform CI regressions surfaced by GitHub checks ([pm-skyg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-skyg.toon))
- Regression and release hardening ([pm-qwp7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-qwp7.toon))

### Removed

- M4 follow-up: remove deleted items from semantic vector indexes ([pm-fdla](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fdla.toon))
- Extend restore to recover missing or deleted item files from history ([pm-g6qd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-g6qd.toon))

### Security

- Ignore local .env files for telemetry/security operations ([pm-qgvj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qgvj.toon))
- Remediate open GitHub findings and recurring checks ([pm-i7w2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-i7w2.toon))
- Add npm provenance attestation to release workflow ([pm-mwap](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mwap.toon))
- Cut public release 2026.3.9 ([pm-1h88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1h88.toon))
- Release hardening: scoped npm + version policy + CI ([pm-1hm2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-1hm2.toon))
- Fix devDependency security vulnerabilities via c8 and rollup updates ([pm-r3fi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r3fi.toon))
- Harden include-linked symlink containment ([pm-lxa0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lxa0.toon))
- Harden include-linked path containment ([pm-q35x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-q35x.toon))
- M5: Enforce symlink-resolved extension entry boundary ([pm-fsyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fsyv.toon))
- Track and commit imported pm issue/history files ([pm-rbdu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rbdu.toon))
- Sanitize publishable worktree before push ([pm-mcli](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-mcli.toon))
- Track GitHub Dependabot alert \#12 for undici (GHSA-cxrh-j4jr-qwg3) ([pm-pagj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pagj.toon))
- Track GitHub Dependabot alert \#11 for undici (GHSA-9qxr-qj54-h672) ([pm-tl4d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-tl4d.toon))
- Track GitHub Dependabot alert \#10 for undici (GHSA-m4v8-wqvr-p9f7) ([pm-ipul](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ipul.toon))
- Track GitHub Dependabot alert \#9 for undici (GHSA-3787-6prv-h9w3) ([pm-d3i5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-d3i5.toon))
- Track GitHub Dependabot alert \#8 for undici (GHSA-wqq4-5wpv-mx2g) ([pm-v6vi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-v6vi.toon))
- Track GitHub Dependabot alert \#2 for undici (GHSA-q768-x9m6-m9qp) ([pm-5p3z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5p3z.toon))
- Track GitHub Dependabot alert \#18 for undici (GHSA-2mjp-6q6p-2qxm) ([pm-10no](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-10no.toon))
- Track GitHub Dependabot alert \#20 for undici (GHSA-phc3-fgpg-7m6h) ([pm-090w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-090w.toon))
- Track GitHub Dependabot alert \#21 for undici (GHSA-4992-7rv2-5pvq) ([pm-cg7l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-cg7l.toon))
- Track GitHub Dependabot alert \#24 for undici (GHSA-2mjp-6q6p-2qxm) ([pm-x4sy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-x4sy.toon))
- Track GitHub Dependabot alert \#27 for undici (GHSA-4992-7rv2-5pvq) ([pm-02c4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-02c4.toon))
- Track GitHub Dependabot alert \#29 for picomatch (GHSA-3v7f-55p6-f55p) ([pm-5e88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5e88.toon))
- Track GitHub Dependabot alert \#13 for undici (GHSA-g9mf-h72j-4rw9) ([pm-51y8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-51y8.toon))
- Track GitHub Dependabot alert \#7 for zod (GHSA-m95q-7qp3-xv42) ([pm-4ydh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-4ydh.toon))
- Track GitHub Dependabot alert \#4 for undici (GHSA-f772-66g8-q5h3) ([pm-eu59](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-eu59.toon))
- Track GitHub Dependabot alert \#3 for undici (GHSA-8qr4-xgw6-wmr3) ([pm-bv2c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-bv2c.toon))
- Track GitHub Dependabot alert \#1 for undici (GHSA-3cvr-822r-rqcc) ([pm-ncbe](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ncbe.toon))
- Track GitHub Dependabot alert \#19 for undici (GHSA-f269-vfmq-vjvj) ([pm-rb9v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-rb9v.toon))
- Track GitHub Dependabot alert \#22 for undici (GHSA-vrm6-8vpv-qv8q) ([pm-i1rm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-i1rm.toon))
- Track GitHub Dependabot alert \#23 for undici (GHSA-v9p9-hfj2-hcw8) ([pm-53q4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-53q4.toon))
- Track GitHub Dependabot alert \#25 for undici (GHSA-vrm6-8vpv-qv8q) ([pm-s5vv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-s5vv.toon))
- Track GitHub Dependabot alert \#26 for undici (GHSA-v9p9-hfj2-hcw8) ([pm-ylg3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-ylg3.toon))
- Track GitHub Dependabot alert \#6 for undici (GHSA-r6ch-mqf9-qc9w) ([pm-8m72](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-8m72.toon))
- Track GitHub Dependabot alert \#5 for fast-json-patch (GHSA-8gh8-hqwg-xf34) ([pm-pacx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-pacx.toon))
- D2: Update compatibility and security/trust guidance ([pm-3949](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3949.toon))
- Documentation, migration, and safety posture ([pm-31fj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-31fj.toon))

### Other

- Run latest-build temp-project dogfood audit and remediate findings ([pm-j16d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-j16d.toon))
- 2026-04-26 Comprehensive PM CLI Dogfood Audit - Full Results ([pm-z87r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/decisions/pm-z87r.toon))
- Continuous governance automation and policy enforcement ([pm-5rjn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-5rjn.toon))
- Telemetry and observability rollout ([pm-lnq3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-lnq3.toon))
- Agent context command ( / ) ([pm-abhj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-abhj.toon))
- Follow-up: enhance calendar UX for agents and LLM parsing ([pm-kglq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kglq.toon))
- Track extension GitHub shorthand source documentation parity ([pm-h8j3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-h8j3.toon))
- Generate unknown-command remediation examples from runtime registry ([pm-a01m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a01m.toon))
- Generate shell completion flags from command contracts ([pm-xhot](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xhot.toon))
- 2026-04-26 comprehensive pm CLI dogfood audit ([pm-8pzn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8pzn.toon))
- Run weekly GitHub findings review ([pm-lou4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lou4.toon))
- Backfill telemetry documentation files referenced in tracker links ([pm-35wb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-35wb.toon))
- Align extension hook docs with runtime types and SDK surface ([pm-hbtn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hbtn.toon))
- C1: Publish explicit extension SDK exports ([pm-l16r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l16r.toon))
- Consolidate 2026-04-25 dogfood audit evidence and tracker links ([pm-odcr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-odcr.toon))
- Clarify config policy value ergonomics for strict modes ([pm-9ayo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9ayo.toon))
- Wave 8/9: restore replay patch compatibility and diagnostics ([pm-n5cw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-n5cw.toon))
- Wave 8/9: clarify get --json body field behavior ([pm-gb25](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gb25.toon))
- Harden mutation-triggered vector refresh coverage across write paths ([pm-bgd8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bgd8.toon))
- Wave 8/9: event parse errors with field-specific attribution ([pm-a3eq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a3eq.toon))
- Expose start-task pause-task close-task as first-class CLI aliases ([pm-3www](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3www.toon))
- Full-repo audit hardening pass (warnings + metadata alignment) ([pm-4vm7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4vm7.toon))
- Run full verification and release evidence for audit remediation ([pm-ac8x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ac8x.toon))
- Help1: Centralize help composer and command narratives ([pm-vf7n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vf7n.toon))
- Preserve confidence in todos import mapping ([pm-zoyg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zoyg.toon))
- CI workflows and quality gates ([pm-wo8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wo8.toon))
- M5 roadmap: Todos import/export extension parity polish ([pm-pu4i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pu4i.toon))
- Implement centralized status alias normalization ([pm-ptal](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ptal.toon))
- M5: Hook lifecycle ([pm-p8p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p8p.toon))
- M5 follow-up: include built-in extensions in health probe ([pm-l88i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l88i.toon))
- M5 roadmap: Beads import extension parity polish ([pm-imob](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-imob.toon))
- T1: Implement stdin and PTY fail-safe behavior ([pm-fas4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-fas4.toon))
- Restore full todos import metadata parity ([pm-ecbn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ecbn.toon))
- Retire pm install path semantics with command removal ([pm-cxn3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cxn3.toon))
- Drive repository coverage gate back to 100 percent ([pm-r28k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r28k.toon))
- PM CLI governance and documentation overhaul ([pm-wtsp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-wtsp.toon))
- M5 hardening: unknown extension capability diagnostics ([pm-hzh6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hzh6.toon))
- M5 follow-up: validate extension registration handler types ([pm-qkx0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qkx0.toon))
- External issue report remediation 2026-04-05 ([pm-gt8u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-gt8u.toon))
- Ship1: Full verification, closure evidence, commit, and push ([pm-y76e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-y76e.toon))
- Sync docs and contracts for external audit remediation ([pm-c8dz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-c8dz.toon))
- External follow-up: suppress EPIPE stack traces in piped output ([pm-4emi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4emi.toon))
- Governance standards alignment follow-up 2026-04-04 ([pm-xjf9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xjf9.toon))
- Background linked-test service and item result tracking ([pm-lm0j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-lm0j.toon))
- Persist bounded test run summaries on item records ([pm-i2pc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i2pc.toon))
- Run background-service release verification and closure evidence ([pm-9ik7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-9ik7.toon))
- Sync prompt docs with close workflow ([pm-vx7l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-vx7l.toon))
- Create contract verification sample ([pm-awo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-awo.toon))
- Sync prompt-03 create template with canonical contract ([pm-wi28](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-wi28.toon))
- Release-readiness maintenance loop 2026-03-06 ([pm-tkie](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-tkie.toon))
- Release readiness maintenance sweep ([pm-r59c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-r59c.toon))
- Harden settings serialization contract coverage ([pm-gm5l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gm5l.toon))
- Sync legacy prompt docs with create contract ([pm-h22w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-h22w.toon))
- Maintain release readiness 2026-03-09 (Run 9) ([pm-7vr0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-7vr0.toon))
- Maintain release readiness 2026-03-09 (Run 8) ([pm-2cr5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-2cr5.toon))
- Maintain release readiness 2026-03-09 (Run 7) ([pm-zre8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-zre8.toon))
- Maintain release readiness 2026-03-09 (Run 6) ([pm-j0o4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-j0o4.toon))
- Maintain release readiness 2026-03-09 (Run 5) ([pm-6k5l](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-6k5l.toon))
- Maintain release readiness 2026-03-09 (Run 4) ([pm-eyoz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-eyoz.toon))
- Maintain release readiness 2026-03-09 (Run 3) ([pm-k4u5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-k4u5.toon))
- Maintain release readiness 2026-03-09 ([pm-o4ky](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-o4ky.toon))
- Release-readiness maintenance loop 2026-03-09 ([pm-36zp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-36zp.toon))
- Release-readiness maintenance loop 2026-03-08 run 1 (chore archival variant) ([pm-knwz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-knwz.toon))
- Release-readiness maintenance loop 2026-03-07 run 11 ([pm-dyu6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-dyu6.toon))
- Release-readiness maintenance loop 2026-03-07 run 10 ([pm-u8fr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-u8fr.toon))
- Release-readiness maintenance loop 2026-03-07 run 9 ([pm-acx9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-acx9.toon))
- README maintainer bootstrap parity with AGENTS ([pm-8mkp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-8mkp.toon))
- Contributing maintainer bootstrap global-install parity ([pm-m91u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-m91u.toon))
- Release-readiness loop: enforce global install bootstrap contract ([pm-uh4d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-uh4d.toon))
- Close-workflow contract guard across docs and runtime ([pm-fvox](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fvox.toon))
- AGENTS closed-sweep guidance and contract guard ([pm-gsd9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-gsd9.toon))
- Packaging hardening for npm release ([pm-cyj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-cyj.toon))
- M5 roadmap: Runtime wiring for extension registrations ([pm-jvfw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-jvfw.toon))
- M5 roadmap: Broader override surfaces ([pm-bfd9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bfd9.toon))
- M5 roadmap: Broader call-site expansion for hooks ([pm-m6yd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-m6yd.toon))
- M5 roadmap: Broader command sandbox API boundary ([pm-qype](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qype.toon))
- M4 roadmap: Broader multi-factor tuning for hybrid search ([pm-qyyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qyyv.toon))
- M4 roadmap: Broader adapter optimization and persistence refinements ([pm-8ikr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8ikr.toon))
- M4 roadmap: Advanced provider optimization ([pm-ip91](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ip91.toon))
- M4 roadmap: mutation-triggered semantic embedding refresh ([pm-eg97](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eg97.toon))
- T6: Run full verification, close items, and ship ([pm-r4t0](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r4t0.toon))
- Expand README quick start create example to full field surface ([pm-mltd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mltd.toon))
- Generalize CLI help text for universal positioning ([pm-30zl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-30zl.toon))
- Make semantic search fully working using Ollama ([pm-b4pb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-b4pb.toon))
- Guard todos import hierarchical ID preservation ([pm-57lj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-57lj.toon))
- M4 follow-up: resolve search sonar warnings ([pm-f35q](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f35q.toon))
- M4 follow-up: semantic/hybrid search limit=0 deterministic empty result ([pm-6mn1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-6mn1.toon))
- M4: Honor embedding batch + retry settings in semantic indexing ([pm-i25f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-i25f.toon))
- Optimize test-all dedupe across timeout variants ([pm-cnil](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cnil.toon))
- Release-readiness verification and baseline dogfood sweep ([pm-scca](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-scca.toon))
- Sync AGENTS Pi create example with explicit contract ([pm-oie4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oie4.toon))
- Enforce close-command closure path ([pm-3nv9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3nv9.toon))
- M5 follow-up: surface registerFlags on dynamic command help ([pm-vqam](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vqam.toon))
- M5 hardening: enforce extension capability declarations ([pm-mwwp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mwwp.toon))
- Harden sandbox guard for run-script test commands ([pm-q813](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-q813.toon))
- M5 follow-up: classify applied extension migrations ([pm-cw6c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cw6c.toon))
- M5 follow-up: enforce mandatory extension migration write gate ([pm-2p5x](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2p5x.toon))
- M5 follow-up: report pending extension migrations in health ([pm-42oa](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-42oa.toon))
- M5 follow-up: dispatch lock lifecycle hooks ([pm-671u](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-671u.toon))
- M3 follow-up: harden activity when history directory is missing ([pm-er7n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-er7n.toon))
- M5 follow-up: isolate hook execution contexts ([pm-3ses](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3ses.toon))
- M5 follow-up: Extension API registration surface baseline ([pm-iuzs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-iuzs.toon))
- M5 follow-up: dispatch onWrite hooks for create and restore ([pm-f3q4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f3q4.toon))
- M5 follow-up: health extension activation probe ([pm-pjj7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pjj7.toon))
- M5 follow-up: health history stream read hook dispatch ([pm-ndb1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ndb1.toon))
- Harden chained sandbox env detection per segment ([pm-wdgn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wdgn.toon))
- Reject flagged package-manager test runners in pm test --add ([pm-mlc3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mlc3.toon))
- Harden recursive test-all detection for pnpm dlx and npm exec launchers ([pm-11t5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-11t5.toon))
- Record explicit acceptance_criteria unset in create history metadata ([pm-7pp6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7pp6.toon))
- Harden recursive test-all detection for npx package specs ([pm-8fvl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8fvl.toon))
- M5 follow-up: activity history directory read hook dispatch ([pm-xyv3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-xyv3.toon))
- M5 follow-up: isolate override and renderer contexts ([pm-8d71](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8d71.toon))
- M5: Harden extension command handler context sandbox ([pm-0e8w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0e8w.toon))
- M5 follow-up: validate extension hook registration handlers ([pm-30lh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-30lh.toon))
- Harden recursive test-all detection for global-flag invocation forms ([pm-k3zx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k3zx.toon))
- M5 follow-up: normalize extension command path whitespace ([pm-433d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-433d.toon))
- M5 follow-up: dispatch onIndex hooks in gc command ([pm-3aeu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3aeu.toon))
- M4: Mutation-triggered search cache invalidation ([pm-zgkk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zgkk.toon))
- M4: Strict keyword search filter validation parity ([pm-r5ku](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r5ku.toon))
- M6: Command help and README examples validated in tests ([pm-15o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-15o.toon))
- M6: Fixture corpus for restore import and search ([pm-si1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-si1.toon))
- M6: CI matrix finalized ([pm-8z7](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8z7.toon))
- M5: Renderer and command extension points ([pm-geq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-geq.toon))
- M5: Extension manifest loader and sandbox boundary ([pm-7sd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7sd.toon))
- M4: Reindex command ([pm-nj3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nj3.toon))
- M4: Hybrid ranking and include-linked option ([pm-cwp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cwp.toon))
- M4: Vector store adapters for Qdrant and LanceDB ([pm-kj4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kj4.toon))
- M4: Embedding provider abstraction ([pm-yv2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yv2.toon))
- M3: stats health and gc commands ([pm-zau](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zau.toon))
- M3: test-all orchestration and dependency-failed exit handling ([pm-66o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-66o.toon))
- M3: comments files docs and test commands ([pm-kwl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-kwl.toon))
- M3: list and list-\* filters with deterministic sort ([pm-r0m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-r0m.toon))
- M2: Restore by timestamp or version with replay and hash validation ([pm-9lc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9lc.toon))
- M2: History and activity commands ([pm-2fj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2fj.toon))
- M2: Append-only history writer ([pm-pg9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pg9.toon))
- M1: Lock acquire release with TTL and conflicts ([pm-nkx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nkx.toon))
- M1: ID generation and normalization ([pm-dgb](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dgb.toon))
- M1: Markdown item parser and serializer ([pm-l4o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l4o.toon))
- M0: Error model and exit code mapping ([pm-siz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-siz.toon))
- M0: Deterministic serializer utilities ([pm-vdh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vdh.toon))
- M0: Project scaffolding CLI entrypoint config loader ([pm-k8v](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-k8v.toon))
- Replace docs-as-contract tests with pm-data/runtime checks ([pm-sevn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sevn.toon))
- Docs parity: mark Pi wrapper packaging polish as implemented ([pm-du3c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-du3c.toon))
- Release-readiness maintenance loop 2026-03-08 run 2 ([pm-3tjx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3tjx.toon))
- Release-readiness maintenance loop 2026-03-08 run 1 ([pm-vz16](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vz16.toon))
- Promote unblock-note to canonical workflow field ([pm-1p6f](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1p6f.toon))
- Release-readiness maintenance loop 2026-03-07 run 8 ([pm-a5ea](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-a5ea.toon))
- Release-readiness maintenance loop 2026-03-07 run 7 ([pm-wjdr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wjdr.toon))
- Release-readiness maintenance loop 2026-03-07 run 6 ([pm-mn6w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mn6w.toon))
- Release-readiness maintenance loop 2026-03-07 run 5 ([pm-f0e9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-f0e9.toon))
- Release-readiness maintenance loop 2026-03-07 run 4 ([pm-iziy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-iziy.toon))
- Release-readiness maintenance loop 2026-03-07 run 3 ([pm-204c](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-204c.toon))
- Release-readiness maintenance loop 2026-03-07 run 2 ([pm-phpq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-phpq.toon))
- Normalize duplicate milestone epics in tracker ([pm-d9yz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-d9yz.toon))
- Bootstrap dogfood backlog and execute highest-priority gap ([pm-ep96](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ep96.toon))
- Release-readiness audit and next hardening changeset ([pm-lfae](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-lfae.toon))
- Release-readiness drift audit and sync ([pm-mpd6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-mpd6.toon))
- Testing strategy and 100 percent coverage gates ([pm-912](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-912.toon))
- Docs contract sync for release readiness ([pm-pq8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-pq8.toon))
- External audit issue remediation and compatibility hardening ([pm-my6o](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-my6o.toon))
- Universal terminal compatibility hardening ([pm-mudv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-mudv.toon))
- Milestone 6 - Hardening + Release Readiness ([pm-jiw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-jiw.toon))
- Milestone 5 - Extension System + Built-ins ([pm-b1w](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-b1w.toon))
- Milestone 4 - Search ([pm-f45](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-f45.toon))
- Milestone 3 - Query + Operations ([pm-54d](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-54d.toon))
- Milestone 2 - History + Restore ([pm-c0r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-c0r.toon))
- Milestone 1 - Core Item CRUD + Locking ([pm-u9r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-u9r.toon))
- Milestone 0 - Foundations ([pm-2xl](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-2xl.toon))
- Build pm-cli v1 ([pm-j7a](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-j7a.toon))
- Align extension metadata and completion/wrapper parity ([pm-h2eo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h2eo.toon))
- Issue2 Task: Structured linked-test failure classification ([pm-4g5i](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-4g5i.toon))
- Enforce command-required linked test mutations ([pm-wn34](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wn34.toon))
- Implement sandbox seeding for project/global extension parity ([pm-qtvv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qtvv.toon))
- External audit follow-up docs sync and verification gate ([pm-ykgu](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ykgu.toon))
- Track open Dependabot PR \#5 ([pm-akty](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-akty.toon))
- Track open Dependabot PR \#6 ([pm-7akk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7akk.toon))
- Track open Dependabot PR \#7 ([pm-n8w4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-n8w4.toon))
- Track open Dependabot PR \#10 ([pm-eoil](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-eoil.toon))
- Track open Dependabot PR \#12 ([pm-16pn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-16pn.toon))
- Verify extension manager rollout and deliver release evidence ([pm-3gzy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3gzy.toon))
- Overhaul extension and SDK documentation with install equivalence examples ([pm-cdsf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-cdsf.toon))
- Sync docs/contracts/wrapper parity for unresolved external audit additions ([pm-tcx8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tcx8.toon))
- Task: harden comments force guidance across help/docs/completion ([pm-8k83](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8k83.toon))
- Task: allow claim takeover without force for non-terminal items ([pm-05u4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-05u4.toon))
- Phase 2: full verification matrix and closure evidence ([pm-1had](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1had.toon))
- Phase 2: publish SDK contracts for parser/preflight/services ([pm-j24z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-j24z.toon))
- Phase 2: compatibility adapters and migration diagnostics ([pm-ngdf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ngdf.toon))
- Phase 2: integrate service overrides into core modules ([pm-leol](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-leol.toon))
- Phase 2: implement service override contracts and runtime registry ([pm-78jt](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-78jt.toon))
- Phase 2: lifecycle mutation safety and compatibility tests ([pm-5mqd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-5mqd.toon))
- Phase 2: implement extension preflight override pipeline ([pm-sh14](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-sh14.toon))
- Phase 2: wire parser override contracts in runtime ([pm-nfii](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-nfii.toon))
- Finalize tests docs verification and release evidence for history hardening ([pm-0vnr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0vnr.toon))
- Implement shared history-stream policy helper and command enforcement ([pm-1tyv](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-1tyv.toon))
- Document and verify health drift/vectorization changes ([pm-yo5m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-yo5m.toon))
- Implement health vectorization targeted refresh ([pm-v48k](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-v48k.toon))
- Implement health history drift diagnostics ([pm-x0vj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x0vj.toon))
- Implement Ollama-aware semantic default resolution in runtime ([pm-wn3r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-wn3r.toon))
- Docs1: Refresh README/PRD/architecture/extensions/changelog ([pm-qhcw](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-qhcw.toon))
- Output1: Implement command-aware non-JSON result summaries ([pm-x3fh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-x3fh.toon))
- Error1: Introduce structured error model and builders ([pm-gggs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gggs.toon))
- T3: Harden linked-test subprocess anti-hang behavior ([pm-dzrj](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-dzrj.toon))
- Docs/help refresh for expanded deadline/date inputs ([pm-9sg4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9sg4.toon))
- C1: Implement intuitive comments argument parsing ([pm-hcco](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-hcco.toon))
- Wire resilient entry ingestion across mutation commands ([pm-0pvk](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0pvk.toon))
- Implement tolerant entry parser and stdin token utility ([pm-luay](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-luay.toon))
- E2: Final verification and closure evidence ([pm-rl7j](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rl7j.toon))
- D1: Rewrite extension and architecture docs for full override ([pm-8qne](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-8qne.toon))
- C2: Backward-safe extension SDK compatibility shims ([pm-bw3h](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-bw3h.toon))
- B3: Executable extension migration lifecycle ([pm-twpm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-twpm.toon))
- B2: Wire search providers and vector adapters ([pm-14qs](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-14qs.toon))
- B1: Wire registerItemFields into runtime validation ([pm-t0yd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t0yd.toon))
- A3: Hook context parity and lifecycle symmetry ([pm-osk5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-osk5.toon))
- A2: Core override precedence and collision diagnostics ([pm-t6xf](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-t6xf.toon))
- A1: Unified extension-first command router ([pm-2bxh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-2bxh.toon))
- Support type-aware storage routing and safe type moves ([pm-rv63](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-rv63.toon))
- Build and wire runtime item type registry ([pm-h1no](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-h1no.toon))
- Follow-up: expand built-in item types for calendar-native work ([pm-p5q3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-p5q3.toon))
- Document recurrence features and finalize release evidence ([pm-tytr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-tytr.toon))
- Implement recurrence occurrence expansion in calendar views ([pm-0c0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0c0g.toon))
- Implement calendar command core views and filtering ([pm-ezri](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ezri.toon))
- Implement reminder schema validation and deterministic ordering ([pm-7e6n](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-7e6n.toon))
- Integrate command and extension format behavior ([pm-3aga](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3aga.toon))
- Implement automatic migration and mutation gate ([pm-s0ne](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-s0ne.toon))
- Implement dual-format codec and store lookup ([pm-oex4](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-oex4.toon))
- Implement item_format settings model ([pm-9689](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-9689.toon))
- Document include-body list contract and capture validation evidence ([pm-gudp](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-gudp.toon))
- Implement include-body retrieval in list command pipeline ([pm-vsux](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-vsux.toon))
- Rewrite README for public users ([pm-uc33](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-uc33.toon))
- M1: Item schema model and validation ([pm-3gi](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-3gi.toon))
- Track open Dependabot PR \#9 ([pm-u4hy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-u4hy.toon))
- Track open Dependabot PR \#14 ([pm-0jpx](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-0jpx.toon))
- Differentiate pm list (active-only) from pm list-all (all items) ([pm-zzt1](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-zzt1.toon))
- Issue3: Validate stale PM-id command references ([pm-br88](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-br88.toon))
- Issue2: Shared-host linked-test determinism ([pm-9dp3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-9dp3.toon))
- External audit Issue1 follow-up: log-seed ambiguity guard ([pm-pb0g](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-pb0g.toon))
- Agent-friendly comments command UX hardening ([pm-v3g3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-v3g3.toon))
- List JSON Body Projection Contract ([pm-0lbm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-0lbm.toon))
- External audit follow-up: linked-test evidence and extension diagnostics ([pm-5z9r](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-5z9r.toon))
- Linked-test parity and runnable command enforcement ([pm-mf5z](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-mf5z.toon))
- External audit follow-up: validation and large-output ergonomics ([pm-qfg8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-qfg8.toon))
- Extension lifecycle manager and SDK parity rollout ([pm-m9jc](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-m9jc.toon))
- Agent-First CLI UX v3 follow-up ([pm-pfn8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-pfn8.toon))
- External audit follow-up: unresolved UX and dependency visualization gaps ([pm-iswo](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-iswo.toon))
- CLI UX and Integrity Hardening ([pm-hp31](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-hp31.toon))
- History stream resilience and restore recovery hardening ([pm-ofh9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-ofh9.toon))
- Health drift and vectorization integrity ([pm-1hkq](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-1hkq.toon))
- Auto-enable semantic search when local Ollama is available ([pm-67uh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-67uh.toon))
- CLI UX Overhaul: Help, Errors, and Output ([pm-izbd](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-izbd.toon))
- Deadline/date parsing compatibility hardening ([pm-va6e](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-va6e.toon))
- Status alias compatibility hardening ([pm-g6a2](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-g6a2.toon))
- Full Override SDK + Extensions Platform ([pm-x395](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-x395.toon))
- Configurable option policies for core commands ([pm-00yy](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-00yy.toon))
- Calendar parity phase 2: events and recurrence ([pm-vdrn](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-vdrn.toon))
- Agent-optimized calendar and reminders ([pm-qh3p](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-qh3p.toon))
- TOON item storage migration ([pm-bckz](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/epics/pm-bckz.toon))
- Code/test/docs for create log-seed ambiguity guard ([pm-l5tr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-l5tr.toon))

## 2026.3.12 - 2026-03-13

### Other

- Release @unbrained/pm-cli 2026.3.12 ([pm-lz4m](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-lz4m.toon))
