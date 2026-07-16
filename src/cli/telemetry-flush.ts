#!/usr/bin/env node
/**
 * @module cli/telemetry-flush
 *
 * Provides CLI runtime support for Telemetry Flush.
 */
import { flushTelemetryQueue } from "../sdk/telemetry-flush.js";

await flushTelemetryQueue();
