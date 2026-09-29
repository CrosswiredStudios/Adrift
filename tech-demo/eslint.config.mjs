import js from "@eslint/js";

// NOTE: typescript-eslint does not support TypeScript 7 yet, so ESLint only
// lints the JS config files. TypeScript sources are linted by the compiler:
// tsconfig.json turns on noUnusedLocals / noUnusedParameters /
// noImplicitReturns / noImplicitOverride / noFallthroughCasesInSwitch, and
// `npm run typecheck` fails on any of them. Style is enforced by prettier.
// When typescript-eslint supports TS 7 (or if you adopt Biome/oxlint), extend
// this config to cover src/ and tests/.

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
