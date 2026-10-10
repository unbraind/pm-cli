# Installed init output

Owner: [pm-release-acceptance-path-cost](../../../.agents/pm/issues/pm-release-acceptance-path-cost.toon).

`installed-init.json` captures the complete public `@unbrained/pm-cli@2026.10.10`
`init --json --no-extensions --yes --prefix accept --no-merge-fence` output from
an isolated npm consumer. Only the disposable workspace path is replaced with
`$WORKSPACE`. Settings, created directories, warnings, guidance and command
examples remain in the captured envelope; credential values are empty.

The verifier test substitutes the actual proposed workspace path, including a
macOS-length temporary base, and measures the complete raw JSON string against
the unchanged 12,000-character init limit. This guards path cost independently
of installed lifecycle tests. Real anonymous npm local/global and Bun sessions
also compare the prior public release with the candidate using the same base;
the fixture does not replace those package-consumer gates.
