import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PM_TELEMETRY_SOURCE_CONTEXT_VALUES } from "../../src/core/telemetry/runtime.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configDocPath = path.join(repoRoot, "docs", "CONFIGURATION.md");

/**
 * pm-r7md: the telemetry env-var surface is only defined in source. This guards
 * that docs/CONFIGURATION.md documents every knob and every valid
 * PM_TELEMETRY_SOURCE_CONTEXT value, so the documented surface cannot silently
 * drift from runtime.ts.
 */
describe("telemetry env-var documentation", () => {
  const TELEMETRY_ENV_VARS = [
    "PM_TELEMETRY_DISABLED",
    "PM_NO_TELEMETRY",
    "PM_TELEMETRY_OTEL_DISABLED",
    "PM_TELEMETRY_INLINE_FLUSH",
    "PM_TELEMETRY_SOURCE_CONTEXT",
    "PM_TELEMETRY_INGEST_KEY",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
  ] as const;

  it("documents every telemetry env var in CONFIGURATION.md", async () => {
    const doc = await readFile(configDocPath, "utf8");
    for (const envVar of TELEMETRY_ENV_VARS) {
      expect(doc, `expected docs/CONFIGURATION.md to document ${envVar}`).toContain(envVar);
    }
  });

  it("documents every valid PM_TELEMETRY_SOURCE_CONTEXT value", async () => {
    const doc = await readFile(configDocPath, "utf8");
    for (const value of PM_TELEMETRY_SOURCE_CONTEXT_VALUES) {
      expect(doc, `expected docs/CONFIGURATION.md to document source context "${value}"`).toContain(value);
    }
  });
});
