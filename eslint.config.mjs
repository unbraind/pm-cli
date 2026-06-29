import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

// Cyclomatic-complexity ceiling for the "Complex Method" no-regression gate.
// Calibrated to CodeFactor's "Complex Method" detector (which flags methods at
// cyclomatic complexity >= 18): `max: 17` makes ESLint error on any function at
// CC >= 18, so a newly-introduced complex method fails `pnpm lint` in CI. Every
// pre-existing violation is grandfathered in `eslint-suppressions.json`
// (regenerate with `pnpm lint:complexity:baseline`), so the gate blocks net-new
// per-file complexity debt while the baseline is maintained. It is not a
// location-aware delta check for already-suppressed functions; pruning the file
// baseline to empty is the path to a CodeFactor A+ (tracked under epic pm-92if).
const CODEFACTOR_MAINTAINABILITY_RULES = {
  complexity: ["error", { max: 17 }],
  "no-unsafe-optional-chaining": "error",
  "unicorn/no-thenable": "error",
  "unicorn/no-useless-fallback-in-spread": "error",
  "unicorn/no-useless-length-check": "error",
  "unicorn/no-useless-spread": "error",
};

const SHARED_IGNORES = [
  ".agents/**",
  ".cache/**",
  ".codex/**",
  ".gemini/**",
  ".pnpm-store/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "tests/**",
];

export default [
  {
    ignores: SHARED_IGNORES,
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {
      unicorn,
    },
    rules: CODEFACTOR_MAINTAINABILITY_RULES,
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      unicorn,
    },
    rules: CODEFACTOR_MAINTAINABILITY_RULES,
  },
];
