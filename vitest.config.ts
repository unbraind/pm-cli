import { defineConfig } from "vitest/config";

const coverageReporters = process.env.CI
  ? (["text", "json-summary"] as const)
  : (["text", "json-summary", "html"] as const);

const allSourceCoverageThresholds = {
  lines: 92,
  branches: 84,
  functions: 94,
  statements: 92,
};

export default defineConfig({
  cacheDir: ".cache/vitest",
  test: {
    include: ["tests/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: coverageReporters,
      include: ["src/*.ts", "src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      thresholds: allSourceCoverageThresholds,
    },
  },
});
