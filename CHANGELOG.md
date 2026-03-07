# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository governance baseline documents: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.
- Sandboxed test runner script: `scripts/run-tests.mjs` for safe pm-linked test execution with temporary `PM_PATH` and `PM_GLOBAL_PATH`.

### Changed
- Documentation contracts (`PRD.md`, `README.md`, `AGENTS.md`) now explicitly require community files and sandbox-safe pm-driven test execution.

## [0.1.0] - 2026-02-17

### Added
- Initial `pm-cli` v0.1.0 command surface and release-hardening baseline.
