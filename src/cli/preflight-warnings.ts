/** Preserve preflight advisories without prefixing a JSON failure envelope. */
import { AsyncLocalStorage } from "node:async_hooks";
import { printError, writeStderr } from "../sdk/runtime-primitives.js";

const pendingWarnings = new AsyncLocalStorage<
  Map<string, string> | undefined
>();

/** Emit human diagnostics immediately or retain codes in the current JSON invocation. */
export function emitPreflightWarning(
  code: string,
  humanMessage = `warning:${code}`,
): void {
  const warnings = pendingWarnings.getStore();
  if (warnings) {
    if (!warnings.has(code) || humanMessage !== `warning:${code}`)
      warnings.set(code, humanMessage);
  } else {
    printError(humanMessage);
  }
}

/** Consume pending advisories into the failure while preserving existing diagnostics. */
export function attachPreflightWarnings<T extends object>(envelope: T): T {
  const warnings = pendingWarnings.getStore();
  if (!warnings?.size) return envelope;
  const existing = Reflect.get(envelope, "warnings");
  const details = [...warnings]
    .filter(([code, message]) => message !== `warning:${code}`)
    .map(([code, message]) => ({ code, message }));
  const existingDetails = Reflect.get(envelope, "warning_details");
  const result = {
    ...envelope,
    warnings: [
      ...(Array.isArray(existing) ? existing : []),
      ...warnings.keys(),
    ],
    ...(details.length > 0
      ? {
          warning_details: [
            ...(Array.isArray(existingDetails) ? existingDetails : []),
            ...details,
          ],
        }
      : {}),
  };
  warnings.clear();
  return result;
}

/** Attach advisories to an already-rendered Commander JSON refusal. */
export function attachSerializedPreflightWarnings(envelope: string): string {
  if (!pendingWarnings.getStore()?.size) return envelope;
  return JSON.stringify(
    attachPreflightWarnings(JSON.parse(envelope) as object),
    null,
    2,
  );
}

/** Isolate nested/concurrent invocations and publish remaining successful-command warnings once. */
export async function runWithPreflightWarnings(
  json: boolean,
  run: () => Promise<void>,
): Promise<void> {
  if (!json) {
    await pendingWarnings.run(undefined, run);
    return;
  }
  const warnings = new Map<string, string>();
  await pendingWarnings.run(warnings, async () => {
    await run();
    if (warnings.size > 0)
      writeStderr(
        `${JSON.stringify(attachPreflightWarnings({ type: "warning" }))}\n`,
      );
  });
}
