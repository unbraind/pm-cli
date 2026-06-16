import { fileURLToPath } from "node:url";

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
  resolve: {
    alias: [
      // The docs/examples reference scripts import the published package by its
      // bare specifier (`@unbrained/pm-cli/sdk`). Under test that resolves only
      // via the workspace self-link in node_modules, which is absent in a clean
      // CI `pnpm install`. Resolve the bare SDK specifier to source so the
      // example coverage specs are independent of the self-link and the built
      // dist artifact. The published SDK shape itself is covered by sdk-index.
      {
        find: /^@unbrained\/pm-cli\/sdk$/,
        replacement: fileURLToPath(new URL("./src/sdk/index.ts", import.meta.url)),
      },
    ],
  },
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
