import js from "@eslint/js";

// NOTE: typescript-eslint does not support TypeScript 7 yet, so ESLint only
// lints JS/MJS configs here. TypeScript correctness is enforced by
// `npm run typecheck` (tsc --noEmit, strict, includes src + tests) and style
// by `npm run format:check` (prettier). Revisit a TS parser when
// typescript-eslint supports TS >= 7.1.

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "test-results/**"],
  },
  {
    files: ["*.config.mjs", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
];
