import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Strip the leading `#!/usr/bin/env node` shebang from repository `.mjs`
 * scripts before they are compiled under test.
 *
 * The script-test harness ({@link ./tests/helpers/scriptModule.ts}) imports
 * these scripts through Vite. On Windows, Vite's default transform does not
 * strip the shebang the way it does on POSIX, so the leading `#!` reaches the
 * module compiler and throws `SyntaxError: Invalid or unexpected token` —
 * turning the entire Windows nightly red. Removing the shebang text (while
 * preserving the newline, so line numbers and coverage mapping are unchanged)
 * in a `pre` transform makes the script imports load identically on every
 * platform without touching the production script files, which still ship the
 * shebang for direct execution.
 */
const stripScriptShebang: Plugin = {
  name: "pm-strip-script-shebang",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]scripts[\\/][^?]*\.mjs(\?|$)/.test(id)) {
      return null;
    }
    // Tolerate a leading UTF-8 BOM (Windows editors sometimes prepend one)
    // before the shebang so the strip still fires.
    const body = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code;
    if (!body.startsWith("#!")) {
      return null;
    }
    return { code: body.replace(/^#!.*/, ""), map: null };
  },
};

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
  plugins: [stripScriptShebang],
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
        // The reference extensions (starter/policy-restricted) are authored AND
        // loaded as TypeScript and exercised through their `.ts` source, exactly
        // like the first-party `packages/**/*.ts`. The `.ts` IS the manifest entry
        // the loader imports directly (ADR pm-m1uz); there is no compiled `.js`, so
        // only `.ts` (and the embedding/contract-consumer `.mjs` scripts) are
        // tracked.
        "docs/examples/**/*.ts",
        "docs/examples/**/*.mjs",
      ],
      exclude: ["src/**/*.d.ts"],
      thresholds: allSourceCoverageThresholds,
    },
  },
});
