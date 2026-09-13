import { afterEach, expect, it, vi } from "vitest";
import { _testOnly } from "../../../../src/core/telemetry/runtime.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([{ json: true }, { quiet: true }])("keeps machine diagnostics clean for %j", (global) => {
  vi.stubEnv("PM_TELEMETRY_SOURCE_CONTEXT", "private-project-value");
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(_testOnly.resolveTelemetrySourceContext(global).source_context_source).toBe("env_override_rejected");
  expect(warning).not.toHaveBeenCalled();
});

it("distinguishes rejected source attribution without disclosing the attempted value", () => {
  vi.stubEnv("PM_TELEMETRY_SOURCE_CONTEXT", "private-project-value");
  const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(_testOnly.resolveTelemetrySourceContext({}).source_context_source).toBe("env_override_rejected");
  expect(_testOnly.resolveTelemetrySourceContext({}).source_context_source).toBe("env_override_rejected");
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0]?.[0]).toContain("user|automation|test|dogfood");
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-project-value");
});
