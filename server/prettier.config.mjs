/**
 * Prettier config for the TypeScript server.
 *
 * Deliberately close to Prettier's defaults — the settings below encode what
 * this codebase already did by hand, so adopting Prettier reformatted code
 * rather than restyling it:
 *
 *  - Double quotes (Prettier's default) because every one of the 76 existing
 *    import statements already used them. Switching to single quotes would
 *    have rewritten every file for no benefit.
 *  - `printWidth: 100` because the prose-heavy docblocks here are written to
 *    roughly that width; Prettier's default 80 would have rewrapped code to a
 *    narrower shape than the comments beside it.
 *
 * Markdown is excluded via .prettierignore — see the note there.
 *
 * @type {import('prettier').Config}
 */
const config = {
  printWidth: 100,
};

export default config;
