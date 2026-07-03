import js from "@eslint/js";
import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

// Cyclomatic-complexity ceiling for the "Complex Method" no-regression gate.
// Calibrated to CodeFactor's "Complex Method" detector (which flags methods at
// cyclomatic complexity >= 18): `max: 17` makes ESLint error on any function at
// CC >= 18, so a newly-introduced complex method fails `pnpm lint` in CI.
// Pre-existing violations are grandfathered in `eslint-suppressions.json`;
// ESLint fails the run when a suppression goes stale (prune with
// `pnpm lint:eslint:prune`), so the baseline can only shrink, and the static
// quality gate enforces a hard budget on its size so it can never grow.
const CODEFACTOR_MAINTAINABILITY_RULES = {
  complexity: ["error", { max: 17 }],
  "no-unsafe-optional-chaining": "error",
  "unicorn/no-thenable": "error",
  "unicorn/no-useless-fallback-in-spread": "error",
  "unicorn/no-useless-length-check": "error",
  "unicorn/no-useless-spread": "error",
};

// Node-runtime globals shared by ESM scripts and TypeScript files (no type-aware
// project service on the hot lint path; `pnpm typecheck` owns full type analysis).
const NODE_GLOBALS = {
  process: "readonly", console: "readonly", Buffer: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
  clearInterval: "readonly", setImmediate: "readonly", clearImmediate: "readonly", queueMicrotask: "readonly",
  URL: "readonly", URLSearchParams: "readonly", TextEncoder: "readonly",
  TextDecoder: "readonly", fetch: "readonly", AbortController: "readonly",
  AbortSignal: "readonly", performance: "readonly", structuredClone: "readonly",
  crypto: "readonly", atob: "readonly", btoa: "readonly",
  global: "readonly", globalThis: "readonly", WebSocket: "readonly", Blob: "readonly", FormData: "readonly",
  Response: "readonly", Request: "readonly", Headers: "readonly",
};

const COMMONJS_GLOBALS = {
  __dirname: "readonly", __filename: "readonly", require: "readonly", module: "readonly", exports: "readonly",
};

const UNUSED_VARS_OPTIONS = { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" };

export default [
  {
    ignores: [
      // tests/** is intentionally linted; existing test-file violations live
      // in eslint-suppressions.json and are capped by the static quality gate.
      ".agents/**",
      ".cache/**",
      ".codex/**",
      ".gemini/**",
      ".pnpm-store/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: NODE_GLOBALS },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { unicorn },
    rules: CODEFACTOR_MAINTAINABILITY_RULES,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { globals: COMMONJS_GLOBALS },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      "no-unused-vars": ["error", UNUSED_VARS_OPTIONS],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", UNUSED_VARS_OPTIONS],
    },
  },
];
