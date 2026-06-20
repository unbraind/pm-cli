# Changelog

## 2026.6.20 - 2026-06-20

### Fixed

- Relax changelog title escaping for readable Markdown ([pmc-8t9f](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-8t9f.toon))

### Security

- Refresh pm-changelog dev dependency lock for clean audit ([pmc-licw](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-licw.toon))

## 2026.6.13-1 - 2026-06-13

### Fixed

- Prepend merge promotes a stale Unreleased section into the released version instead of duplicating it (GH \#47) ([pmc-8ssd](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-8ssd.toon))

## 2026.6.8 - 2026-06-08

### Fixed

- Classifier misroutes feature command names containing remove/delete to Removed section ([pmc-ph6q](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-ph6q.toon))

## 2026.6.7 - 2026-06-07

### Added

- Add optional item metadata to changelog entries ([pmc-q671](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-q671.toon))

### Other

- Align package dependencies to pm CLI/SDK 2026.6.6 ([pmc-rr5l](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-rr5l.toon))

## 2026.6.6 - 2026-06-06

### Fixed

- Make body enrichment registry resolution best-effort ([pmc-xl7x](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-xl7x.toon))

## 2026.6.5-1 - 2026-06-05

### Fixed

- suggest-semver computed over all items not visible release sections (GH \#28) ([pmc-isyx](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-isyx.toon))
- body-preview silently empty for real pm items: body not loaded (GH \#27) ([pmc-ztt5](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-ztt5.toon))
- Breaking-change detector substring-matches non-breaking as breaking (GH \#26) ([pmc-18yz](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-18yz.toon))

## 2026.6.5 - 2026-06-05

### Added

- Add opt-in breaking-changes, suggest-semver, body-preview, and emoji-prefix flags ([pmc-se5c](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-se5c.toon))

## 2026.6.4 - 2026-06-04

### Fixed

- Deduplicate label grouping tags in changelog sections ([pmc-an10](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-an10.toon))

## 2026.6.3 - 2026-06-03

### Added

- Opt-in changelog enhancements ([pmc-emx6](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-emx6.toon))
- Add --changelog-json structured document output ([pmc-gl6b](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-gl6b.toon))
- Add --limit and --since-version release windowing ([pmc-xtwa](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-xtwa.toon))
- Add --contributors per-release contributor list ([pmc-imsu](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-imsu.toon))
- Add --conventional Conventional-Commits heading mapping ([pmc-91hn](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-91hn.toon))
- Add --section-by type\|status\|label within-release grouping ([pmc-qro6](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-qro6.toon))

### Fixed

- Zero-regression guarantee for pm-changelog enhancements ([pmc-1w1r](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/decisions/pmc-1w1r.toon))
- Fix changelog export format validation and metadata ([pmc-55cp](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-55cp.toon))

## 2026.6.1 - 2026-06-01

### Fixed

- changelog generate returned {error} (exit 0) on bad flags; plain throw on --check ([pmc-qw3g](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-qw3g.toon))

## 2026.5.29-2 - 2026-05-29

### Added

- Hands-on functional test pass 2026-05-29 (real data) ([pmc-7rd8](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-7rd8.toon))

### Fixed

- Committed CHANGELOG.md stale vs current history (orphaned release tags) ([pmc-e3sy](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-e3sy.toon))

## 2026.5.29-1 - 2026-05-29

### Fixed

- Classifier misroutes Issues with CLI command-name titles (update/change) to Changed not Fixed ([pmc-874d](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-874d.toon))

## 2026.5.27-1 - 2026-05-27

### Added

- Add publish retry + provenance fallback to release workflow ([pmc-ermk](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-ermk.toon))

## 2026.5.27 - 2026-05-27

### Other

- Bump @unbrained/pm-cli SDK to \>=2026.5.24 ([pmc-cfhf](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-cfhf.toon))
- Align CI+release workflows with peer pm-\* packages (Node 22 + Bun) ([pmc-078v](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-078v.toon))

## 2026.5.26 - 2026-05-25

### Fixed

- Fix release tag date drift in changelog checks ([pmc-7dm6](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-7dm6.toon))

### Other

- Release readiness hardening for pm-changelog ([pmc-14cx](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-14cx.toon))

## 2026.5.25 - 2026-05-25

### Added

- Bucket items by release field in full-history changelog ([pmc-dfue](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-dfue.toon))
- Auto-generate full-history CHANGELOG.md in CI without duplicates ([pmc-iuqg](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-iuqg.toon))

### Other

- Cut and publish pm-changelog 2026.5.25-1 release to npm and GitHub ([pmc-9wvl](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-9wvl.toon))
- Production readiness audit and release for pm-changelog 2026-05-25 ([pmc-9mck](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-9mck.toon))
- Bump @types/node to ^25.9.1 and rewire CI to full-history changelog ([pmc-w8iu](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-w8iu.toon))
- Replace inline node -e JavaScript with TypeScript helper ([pmc-vvpy](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-vvpy.toon))
- Verify pm-changelog install and CLI work in a clean temp folder ([pmc-3jj2](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-3jj2.toon))

## 2026.5.24-15 - 2026-05-24

### Fixed

- Stabilize full-history release windows for release automation ([pmc-s1c1](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-s1c1.toon))

## 2026.5.24-14 - 2026-05-24

### Fixed

- Batch git tag timestamp lookup for full-history changelog ([pmc-99tc](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-99tc.toon))

## 2026.5.24-13 - 2026-05-24

### Fixed

- Support full historical changelog generation from git release tags ([pmc-qm7s](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-qm7s.toon))

## 2026.5.24-11 - 2026-05-24

### Fixed

- Prepend mode duplicates Keep a Changelog bracketed release sections ([pmc-nh7q](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-nh7q.toon))

## 2026.5.24-10 - 2026-05-24

### Added

- Add package-owned release context flags ([pmc-34gb](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-34gb.toon))

## 2026.5.24-8 - 2026-05-24

### Added

- Add --item-url-base to release.yml changelog generation steps ([pmc-ew5n](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-ew5n.toon))

## 2026.5.24-7 - 2026-05-24

### Added

- Add --item-url-base option to make pm item IDs clickable links ([pmc-w906](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-w906.toon))

### Changed

- Update @unbrained/pm-cli dev dependency to 2026.5.24 ([pmc-x3cf](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-x3cf.toon))

### Fixed

- Expose item-url-base through pm changelog extension command ([pmc-f4yg](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-f4yg.toon))
- Fix stale file path references in pm items (mjs → ts, dist → dist/cli.js) ([pmc-gn92](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-gn92.toon))
- Fix large tracker generation buffer limit ([pmc-2lzr](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-2lzr.toon))

## 2026.5.24-6 - 2026-05-24

### Fixed

- Changelog sections out of version order when items have different updated_at times ([pmc-36lr](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-36lr.toon))

## 2026.5.24-5 - 2026-05-24

### Other

- Run full release gate and temp install verification 2026-05-24 session 2 ([pmc-ws4p](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-ws4p.toon))
- Production readiness verification 2026-05-24 session 2 ([pmc-9tmr](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-9tmr.toon))

## 2026.5.24-3 - 2026-05-24

### Fixed

- Published package sourcemaps point to missing source files ([pmc-l9z0](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-l9z0.toon))
- Production readiness refresh for pm-changelog sourcemap fix ([pmc-pm02](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-pm02.toon))

### Other

- Production readiness pass 2026-05-24 session ([pmc-96zn](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-96zn.toon))

## 2026.5.24-2 - 2026-05-23

### Security

- Remove host-specific path from published docs ([pmc-sz4m](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-sz4m.toon))

## 2026.5.24-1 - 2026-05-23

### Fixed

- Published npm package missed runtime pm SDK dependency ([pmc-xif2](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-xif2.toon))

## 2026.5.24 - 2026-05-23

### Fixed

- Release workflow used UTC date for local 2026-05-24 release ([pmc-e1jy](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-e1jy.toon))

## 2026.5.23-7 - 2026-05-23

### Added

- Restructure documentation for agent progressive disclosure ([pmc-nuci](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-nuci.toon))
- Use official pm SDK without local extension shims ([pmc-0jm1](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-0jm1.toon))

### Security

- Verify release readiness with GitHub npm pm and history checks ([pmc-scof](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-scof.toon))

### Other

- Production readiness refresh for pm-changelog v2026.05.23-7 ([pmc-t7ie](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-t7ie.toon))
- Convert test source to typed TypeScript ([pmc-yzeq](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-yzeq.toon))

## 2026.5.23-6 - 2026-05-23

### Added

- Enable scheduled npm and GitHub auto release workflow ([pmc-mklv](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-mklv.toon))

### Other

- Verify pm-changelog release workflow and package install path ([pmc-6zxg](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-6zxg.toon))
- Refresh production readiness governance for v2026.05.23-6 ([pmc-l1h7](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-l1h7.toon))

## 2026.5.23-5 - 2026-05-23

### Other

- Production release readiness pass for pm-changelog 2026.5.23-5 ([pmc-qjl9](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-qjl9.toon))

## 2026.5.23-1 - 2026-05-23

### Other

- Fresh production readiness verification for pm-changelog ([pmc-nv97](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-nv97.toon))

## 2026.5.23 - 2026-05-23

### Other

- Post-release production readiness continuation audit ([pmc-ry1j](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-ry1j.toon))

## 0.1.0 - 2026-05-23

### Added

- Regenerate release changelog from pm items ([pmc-a6qg](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-a6qg.toon))
- Harden npm package metadata and CI release gates ([pmc-otpe](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-otpe.toon))

### Fixed

- Publish pm-changelog to npm after registry authentication ([pmc-ek6t](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-ek6t.toon))

### Security

- Audit git history for private data exposure ([pmc-91po](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-91po.toon))

### Other

- Final release verification and npm publication audit ([pmc-jk1a](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-jk1a.toon))
- Release pm-changelog 0.1.0 as a production-ready pm package ([pmc-ysps](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-ysps.toon))
- Document pm governance for the package lifecycle ([pmc-xl68](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-xl68.toon))
- Align GitHub repository settings for public package release ([pmc-w1sp](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-w1sp.toon))
- Verify pm-changelog in a clean temporary project ([pmc-800h](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-800h.toon))
