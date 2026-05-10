#!/usr/bin/env node
import { flushTelemetryQueueNow } from "../core/telemetry/runtime.js";

await flushTelemetryQueueNow();
