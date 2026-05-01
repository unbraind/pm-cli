# Security Policy

## Supported Versions

Security fixes are applied to the latest release line and the default branch under active development.

## Reporting a Vulnerability

If you discover a vulnerability, please report it privately first:

1. Open a private security advisory in GitHub, if available.
2. If advisories are unavailable, open an issue marked `security` with minimal exploit details and request private follow-up.

Please include:

- A clear description of the issue
- Affected versions/commit range
- Reproduction steps or proof of concept
- Suggested mitigation, if known

## Response Expectations

- Initial acknowledgement target: within 3 business days
- Triage and severity assessment: as quickly as possible
- Fix and coordinated disclosure timeline: based on severity and impact

Please avoid public disclosure before a fix or mitigation is available.

## Private Data Handling

Public documentation and package output must not include credentials, host-specific operations details, unpublished evidence logs, or ignored local operations artifacts.

- Keep secrets in environment variables or approved secret stores.
- Do not commit `.env` files or local production operations directories.
- Run `pnpm security:scan` before releases and after touching release/package metadata.
- Prefer minimal reproduction details in public issues; move exploit details to private security channels.

## Extension Runtime Trust Model

`pm` extensions execute as local Node.js code and can intercept command execution, parser/preflight lifecycle, output/error/help rendering, lock/history/item-store service paths, and search/vector runtime paths.

- Treat third-party extensions as fully trusted code.
- Prefer project-reviewed extensions committed to the repository.
- For incident triage or hardening runs, disable extensions with `--no-extensions`.
- In the full trusted-default model, `parser`, `preflight`, and `services` capabilities can bypass or replace core safety gates; only enable these capabilities for audited extensions.
- Include extension manifest name/version, capability list, and active settings selectors (`search.provider`, `vector_store.adapter`) in security reports when relevant.
