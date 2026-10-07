# Packed First-Run Acceptance

Trackers: [pm-ygli86](../.agents/pm/tasks/pm-ygli86.toon),
[pm-rcjyft](../.agents/pm/issues/pm-rcjyft.toon),
[pm-07m41m](../.agents/pm/issues/pm-07m41m.toon),
[pm-p5u6](../.agents/pm/chores/pm-p5u6.toon).

CI globally installs one tarball in isolated npm prefixes on Ubuntu/macOS/Windows
with Node 22.18.0 and 24, runs the installed `pm` shim, then invokes:

```bash
node scripts/release/packed-first-run.mjs /path/to/installed/@unbrained/pm-cli
```

| Journey | Required observation |
| --- | --- |
| Installed README | Ordered init/create/list from `60 Second Example`; missing/reordered commands, unsupported expressions or unbalanced quotes fail. No shell execution. |
| Persistence | Each command returns nonempty output below 4,096 characters; the created item exists. |
| Branch merge | Independent comments survive a real Git merge; reconciliation and strict history verification succeed. |
| MCP | Initialization advertises the installed version. |
| Telemetry | A loopback collector receives detached `command_finish`; queue empties and successful flush persists. One 90-second deadline includes incomplete bodies; start alone cannot pass. |

Detached delivery removes inherited inline/test overrides; other commands/MCP
disable telemetry. Home/global roots are isolated. Interrupts stop stage admission
and collection, waiting five seconds for disposal. CLI errors await actual closure.
MCP waits five seconds after SIGTERM, then SIGKILL plus five more; failure retains
storage/diagnostics. [Storage lifecycle](SDK_STORAGE_LIFECYCLE.md) defines ownership
and abrupt-exit limits.

A separate #1248 regression removes/retargets an owned runtime symlink and performs
a real Git merge, preserving developer runtimes.

Registry propagation, npm/Bun sessions, npx/bunx, production telemetry and previous
compatibility have separate [release acceptance](BUILD_AND_RELEASE_ACCEPTANCE.md).
