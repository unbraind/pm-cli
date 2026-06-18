#!/usr/bin/env node
/**
 * @module cli/telemetry-flush
 *
 * Provides CLI runtime support for Telemetry Flush.
 */
import { flushTelemetryQueueNow } from "../core/telemetry/runtime.js";

await flushTelemetryQueueNow();
