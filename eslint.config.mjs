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

// Node-runtime globals for plain-script linting (no type-aware project service
// on the hot lint path; `pnpm typecheck` owns full type analysis).
const NODE_GLOBALS = {
  process: "readonly", console: "readonly", Buffer: "readonly",
  setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
  clearInterval: "readonly", setImmediate: "readonly", clearImmediate: "readonly", queueMicrotask: "readonly",
  URL: "readonly", URLSearchParams: "readonly", TextEncoder: "readonly",
  TextDecoder: "readonly", fetch: "readonly", AbortController: "readonly",
  AbortSignal: "readonly", performance: "readonly", structuredClone: "readonly",
  crypto: "readonly", atob: "readonly", btoa: "readonly",
  __dirname: "readonly", __filename: "readonly", require: "readonly", module: "readonly", exports: "readonly",
  global: "readonly", globalThis: "readonly", WebSocket: "readonly", Blob: "readonly", FormData: "readonly",
  Response: "readonly", Request: "readonly", Headers: "readonly",
};

export default [
  {
    ignores: [
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
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];
