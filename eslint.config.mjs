import tseslint from "typescript-eslint";
import unicorn from "eslint-plugin-unicorn";

const CODEFACTOR_MAINTAINABILITY_RULES = {
  complexity: ["error", { max: 260 }],
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
