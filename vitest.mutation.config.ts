import { defineConfig } from "vitest/config";

// Reuse behavioral tests without production telemetry, coverage instrumentation,
// or unrelated command integration suites in each mutation worker.
export default defineConfig({
  test: {
    include: [
      "tests/unit/sdk/pagination.spec.ts",
      "tests/unit/sdk/dependency-provenance.spec.ts",
    ],
    retry: 0,
    testTimeout: 5000,
    hookTimeout: 5000,
    env: { PM_SENTRY_DISABLED: "1", PM_TELEMETRY_DISABLED: "1", PM_AGENT_PROBES: "0" },
  },
});
