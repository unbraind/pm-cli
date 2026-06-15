import { defineConfig } from "vitest/config";

const coverageReporters = process.env.CI
  ? (["text", "json-summary"] as const)
  : (["text", "json-summary", "html"] as const);

const allSourceCoverageThresholds = {
  lines: 100,
  branches: 100,
  functions: 100,
  statements: 100,
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
      include: [
        "src/*.ts",
        "src/**/*.ts",
        "packages/**/*.ts",
        "scripts/*.mjs",
        "scripts/**/*.mjs",
        "plugins/*.mjs",
        "plugins/**/*.mjs",
        "docs/examples/**/*.ts",
        "docs/examples/**/*.js",
        "docs/examples/**/*.mjs",
      ],
      exclude: ["src/**/*.d.ts"],
      thresholds: allSourceCoverageThresholds,
    },
  },
});
