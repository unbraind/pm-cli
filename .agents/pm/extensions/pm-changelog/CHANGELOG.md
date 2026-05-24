# Changelog

## v2026.05.24-8

### Added

- Add --item-url-base to release.yml changelog generation steps ([pmc-ew5n](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-ew5n.toon))

## v2026.05.24-7

### Added

- Add --item-url-base option to make pm item IDs clickable links ([pmc-w906](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-w906.toon))

### Changed

- Update @unbrained/pm-cli dev dependency to 2026.5.24 ([pmc-x3cf](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-x3cf.toon))

### Fixed

- Fix stale file path references in pm items \(mjs → ts, dist → dist/cli.js\) ([pmc-gn92](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-gn92.toon))

## v2026.05.24-6

### Fixed

- Changelog sections out of version order when items have different updated\_at times ([pmc-36lr](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-36lr.toon))

## v2026.05.24-5

### Other

- Run full release gate and temp install verification 2026-05-24 session 2 ([pmc-ws4p](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-ws4p.toon))
- Production readiness verification 2026-05-24 session 2 ([pmc-9tmr](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-9tmr.toon))

## v2026.05.24-3

### Fixed

- Production readiness refresh for pm-changelog sourcemap fix ([pmc-pm02](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-pm02.toon))

### Other

- Published package sourcemaps point to missing source files ([pmc-l9z0](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-l9z0.toon))
- Production readiness pass 2026-05-24 session ([pmc-96zn](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-96zn.toon))

## v2026.05.24-2

### Security

- Remove host-specific path from published docs ([pmc-sz4m](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-sz4m.toon))

## v2026.05.24-1

### Other

- Published npm package missed runtime pm SDK dependency ([pmc-xif2](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-xif2.toon))

## v2026.05.24

### Other

- Release workflow used UTC date for local 2026-05-24 release ([pmc-e1jy](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-e1jy.toon))

## v2026.05.23-7

### Added

- Restructure documentation for agent progressive disclosure ([pmc-nuci](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-nuci.toon))
- Use official pm SDK without local extension shims ([pmc-0jm1](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-0jm1.toon))

### Security

- Verify release readiness with GitHub npm pm and history checks ([pmc-scof](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-scof.toon))

### Other

- Production readiness refresh for pm-changelog v2026.05.23-7 ([pmc-t7ie](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-t7ie.toon))
- Convert test source to typed TypeScript ([pmc-yzeq](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-yzeq.toon))

## v2026.05.23-6

### Added

- Enable scheduled npm and GitHub auto release workflow ([pmc-mklv](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-mklv.toon))

### Other

- Verify pm-changelog release workflow and package install path ([pmc-6zxg](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-6zxg.toon))
- Refresh production readiness governance for v2026.05.23-6 ([pmc-l1h7](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-l1h7.toon))

## v2026.05.23-5

### Other

- Production release readiness pass for pm-changelog 2026.5.23-5 ([pmc-qjl9](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-qjl9.toon))

## v2026.05.23-2

### Fixed

- Fix large tracker generation buffer limit ([pmc-2lzr](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-2lzr.toon))

## v2026.05.23-1

### Other

- Fresh production readiness verification for pm-changelog ([pmc-nv97](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-nv97.toon))

## v2026.05.23

### Other

- Post-release production readiness continuation audit ([pmc-ry1j](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-ry1j.toon))

## 0.1.0

### Added

- Regenerate release changelog from pm items ([pmc-a6qg](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-a6qg.toon))
- Harden npm package metadata and CI release gates ([pmc-otpe](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/features/pmc-otpe.toon))

### Security

- Audit git history for private data exposure ([pmc-91po](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-91po.toon))

### Other

- Publish pm-changelog to npm after registry authentication ([pmc-ek6t](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/issues/pmc-ek6t.toon))
- Final release verification and npm publication audit ([pmc-jk1a](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-jk1a.toon))
- Release pm-changelog 0.1.0 as a production-ready pm package ([pmc-ysps](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/epics/pmc-ysps.toon))
- Document pm governance for the package lifecycle ([pmc-xl68](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-xl68.toon))
- Align GitHub repository settings for public package release ([pmc-w1sp](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/chores/pmc-w1sp.toon))
- Verify pm-changelog in a clean temporary project ([pmc-800h](https://github.com/unbraind/pm-changelog/blob/main/.agents/pm/tasks/pmc-800h.toon))
