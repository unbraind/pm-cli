# SDK Storage Lifecycle

Tracked by [pm-p5u6](../.agents/pm/chores/pm-p5u6.toon).

Detached telemetry reads existing settings without scaffolding schemas/identity.
Locks, queue/state rewrites and event/OTLP completion preserve owner-removed
storage. Delivery stays best effort/nonblocking; foreground defaults create parents.

```typescript
import { acquireLock, writeFileAtomic } from "@unbrained/pm-cli/sdk";

const policy = { createParentDirectories: false };
const release = await acquireLock(root, "job", 60, "worker", false, true, 5000, policy);
try {
  await writeFileAtomic(resultPath, serializedResult, policy);
} finally {
  await release();
}
```

Owners initialize lock/result parents; absence fails without recreation. The
policy cannot pin identity or prevent symlink/replacement races. Extension lock
overrides own their lifecycle.

Async scripts use `registerTempOperation`: signal children, check after
uncancellable SDK work, `finish` after finally disposal. Interrupts close admission
and await completion; timeout retains evidence. Sync scripts use
`registerTempCleanup`. Normal failure, SIGINT/SIGTERM (130/143), explicit retention
and caller-owned roots are covered; unrelated roots survive. Abrupt exits retain
async work. SIGKILL/power loss/Windows forced termination cannot run handlers.
Unix tests cover signals; Windows covers callbacks/normal exit.

Real storage, HTTP/OTLP, Git and subprocess regressions complement
[build/registry acceptance](BUILD_AND_RELEASE_ACCEPTANCE.md) and
[packed first run](PACKED_FIRST_RUN.md).
