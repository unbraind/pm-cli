/**
 * @module core/telemetry/read-sampling
 *
 * Bounds expected successful read telemetry per installation and minute.
 * Callers must hold the telemetry queue mutex through this state transition.
 * Only fixed core command names and numeric counters are persisted.
 */
import path from "node:path";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import { resolveTelemetryReadSampleRate, TELEMETRY_SAMPLEABLE_READS } from "./policy.js";

/**
 * Retain the first ten reads of each command per UTC minute, then sample the
 * nth read at (10/n)^2. Expected retained successes stay below twenty per
 * command per minute; this is a statistical bound, not a hard delivery cap.
 * Explicit rates bypass automatic state. Corrupt or inaccessible state retains
 * the invocation. Failures must override the returned probability at finish.
 */
export async function resolveAutomaticReadSampleRate(
  globalPmRoot: string,
  command: string,
  coreReadOwned: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = Date.now(),
): Promise<number> {
  if (!coreReadOwned || !TELEMETRY_SAMPLEABLE_READS.has(command)) return 1;
  if (env.PM_TELEMETRY_READ_SAMPLE_RATE !== undefined) {
    return resolveTelemetryReadSampleRate(command, true, env);
  }
  try {
    const statePath = path.join(globalPmRoot, "runtime", "telemetry", "read-sampling.json");
    const minute = Math.floor(now / 60_000);
    const counts = parseReadCounts(await readFileIfExists(statePath), minute);
    const ordinal = Math.min(Number.MAX_SAFE_INTEGER, (counts[command] ?? 0) + 1);
    counts[command] = ordinal;
    await writeFileAtomic(statePath, `${JSON.stringify({ minute, counts })}\n`);
    return Math.min(1, (10 / ordinal) ** 2);
  } catch {
    return 1;
  }
}

/** Recover only finite fixed-command counters from the current minute; malformed or stale state starts a new window. */
function parseReadCounts(raw: string | null, minute: number): Record<string, number> {
  const counts: Record<string, number> = {};
  let previous: unknown;
  try { previous = JSON.parse(raw ?? "null"); } catch { return counts; }
  if (typeof previous !== "object" || previous === null ||
    !("minute" in previous) || previous.minute !== minute ||
    !("counts" in previous) || typeof previous.counts !== "object" || previous.counts === null) return counts;
  for (const [key, value] of Object.entries(previous.counts as Record<string, unknown>)) {
    if (TELEMETRY_SAMPLEABLE_READS.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return counts;
}
