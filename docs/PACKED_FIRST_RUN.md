# Packed First-Run Acceptance

Tracked by [pm-ygli86](../.agents/pm/tasks/pm-ygli86.toon),
[pm-rcjyft](../.agents/pm/issues/pm-rcjyft.toon), and
[pm-07m41m](../.agents/pm/issues/pm-07m41m.toon).

The `Packed first run` CI matrix installs the same tarball globally into an
isolated npm prefix on Ubuntu, macOS, and Windows, using Node 22.18.0 and Node 24.
It executes the installed `pm` shim before passing the installed package directory
to the acceptance harness:

```bash
node scripts/release/packed-first-run.mjs /path/to/installed/@unbrained/pm-cli
```

The harness extracts the first three commands from the installed README's
`60 Second Example` section. It executes `init`, `create`, and `list` in a
temporary Git workspace, requires nonempty output below 4,096 characters per
command, and checks that the created item was persisted. Missing sections,
reordered commands, unsupported shell expressions, and unbalanced quotes fail.
Arguments are passed directly to the installed CLI without a shell.

Two branches then append independent comments through that CLI. A real Git merge
must preserve both comments and their history. The installed reconciliation and
strict history verifier must succeed. The installed MCP server must complete an
initialize round trip and advertise the installed package version. An additional
mutation enables telemetry only against a loopback HTTP collector. The harness
acknowledges detached delivery batches until it receives `command_finish`, then
verifies the physical queue is empty and a successful flush is recorded.
One 30-second deadline covers the entire collection, including incomplete request
bodies; an initial `command_start` batch alone cannot satisfy acceptance.
It removes inherited inline-flush and
test-runner overrides so this exercises the real detached process. Other commands
and MCP keep telemetry disabled; the install and workspace use isolated home
and global tracker directories.

MCP cleanup waits for process closure before removing its workspace. It allows
five seconds after SIGTERM, then sends SIGKILL and allows five more seconds. If
the child still does not close, the harness fails with captured diagnostics and
retains that workspace rather than attempting removal while it is in use.

The separate runtime-upgrade regression installs drivers through an absolute
runtime symlink, removes the original runtime directory, retargets the symlink,
and performs a real Git merge. It verifies the upgrade failure from GitHub #1248
without altering any developer runtime or repository.

This matrix proves the packed artifact's first-run behavior. Registry propagation,
npm/Bun installed agent sessions, npx/bunx execution, production telemetry, and
previous-release compatibility remain separate acceptance claims under the
[release workflow](RELEASING.md).
