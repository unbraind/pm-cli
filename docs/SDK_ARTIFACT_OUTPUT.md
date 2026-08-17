# SDK artifact output contracts

Trackers: [pm-dilou2](../.agents/pm/issues/pm-dilou2.toon) and [pm-mav1ak](../.agents/pm/features/pm-mav1ak.toon).

Exporter artifacts are data streams, not command receipts. A package declares
the channel when it registers an exporter so the host never guesses whether a
returned value should be appended to artifact bytes.

## Agent quick context

- Declare `output.channel: "stdout"` for JSON, NDJSON, CSV, or opaque bytes.
  The host suppresses its receipt by default, including under global `--json`.
- Declare `output.channel: "file"` when the exporter writes a file. The host
  renders the returned bounded receipt by default.
- An exporter may still return a structured result. Suppressed receipts remain
  available to hooks, telemetry, and embedding hosts.
- Write optional human progress or summaries to stderr. Never mix them into a
  stdout artifact.
- Legacy registrations without `output` retain their previous rendering.

## Registration

```ts
import type { ExtensionApi } from "@unbrained/pm-cli/sdk";

export function activate(api: ExtensionApi): void {
  api.registerExporter(
    "report-json",
    async () => {
      process.stdout.write('{"items":[]}\n');
      return { exported: 0 };
    },
    {
      description: "Export a complete JSON report to stdout.",
      output: {
        channel: "stdout",
        media_type: "application/json",
      },
    },
  );
}
```

The normalized contract is visible in the extension contribution inventory.
Derived help also states that stdout artifact bytes are exclusive and host
receipt rendering is suppressed when the extension does not supply a custom
description.

## Channel behavior

| Artifact channel | Default receipt | stdout | stderr |
| --- | --- | --- | --- |
| `stdout` | `suppress` | Artifact bytes only | Extension-owned diagnostics or summary |
| `file` | `render` | Bounded structured receipt | Extension-owned diagnostics |

`receipt: "render"` and `receipt: "suppress"` are explicit compatibility
controls. Do not choose `render` for a stdout artifact: it intentionally opts
back into the legacy interleaved stream and is unsuitable for redirection,
`jq`, or binary output.

The host does not decode, re-encode, buffer, or inspect stdout artifact bytes.
Consequently NUL bytes and non-UTF-8 payloads pass through unchanged. The
extension owns media correctness and stream completion; the host owns only the
post-handler receipt policy.

## Shared NDJSON framing

SDK-built producers can use `serializeNdjsonStream(rows, trailer)` to append one
typed `pm.stream.trailer` after a bounded row batch. It supplies one stable
place for counts, continuation cursors, source identity, and constant-size
producer metadata without adding per-row overhead.
