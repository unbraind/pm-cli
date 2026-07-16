/**
 * @module sdk/telemetry-flush
 *
 * Owns explicit telemetry queue draining for embedded and detached hosts.
 */
import { flushTelemetryQueueNow } from "../core/telemetry/runtime.js";

/** Flush the durable telemetry queue immediately. */
export async function flushTelemetryQueue(): Promise<void> {
  await flushTelemetryQueueNow();
}
