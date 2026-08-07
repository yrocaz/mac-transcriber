/**
 * ESLint flat config for the TypeScript server.
 *
 * `typescript-eslint` **recommended**, not `strict` or `recommended-type-checked`.
 * The stricter presets flag idioms this codebase is built on (see the rule
 * notes below), and a lint adoption that starts by rewriting working, reviewed
 * code is a worse trade than one that encodes the conventions already in use.
 *
 * `eslint-config-prettier` goes last so formatting is Prettier's job alone and
 * the two tools never disagree about a line.
 *
 * Refs:
 * - https://typescript-eslint.io/getting-started
 * - https://github.com/prettier/eslint-config-prettier
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "test/fixtures/**", "*.config.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Non-null assertion is the house idiom here, and it is load-bearing:
      // `argv[i]!` after a bounds-checked loop, `tokens.shift()!` after a
      // length check, `bar!.start()` inside an `if (showBar)`. TypeScript
      // cannot narrow those, and the alternative — optional chaining plus a
      // throw — would add unreachable branches to already-reviewed code.
      "@typescript-eslint/no-non-null-assertion": "off",

      // Empty catch blocks are deliberate in several places and always carry a
      // comment saying why (walkMediaTree skipping an unreadable directory,
      // runTree's logger refusing to let a failed log kill transcription).
      // Empty blocks of any other kind stay an error.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Enabled because the codebase already carries `eslint-disable-next-line
      // no-console` directives at its few deliberate console calls (server
      // lifecycle logging in index.ts, persist failures in jobStore.ts). With
      // the rule off those directives are dead text; with it on they document
      // the exceptions. Everything user-facing goes through process.stderr.
      "no-console": "error",

      // `_`-prefixed args are the conventional "required by signature, unused
      // here" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests reach into internals and stub types the real callers never see.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      // The E2E suite prints why it skipped (missing helper binary, missing
      // generated fixtures). That message is the whole point of the skip —
      // a silent skip reads as a pass — and console is where a test runner
      // shows it.
      "no-console": "off",
    },
  },
);
