#!/usr/bin/env node
import { ensureSentryInit } from "./core/sentry/instrument.js";

await ensureSentryInit();
await import("./cli/main.js");
