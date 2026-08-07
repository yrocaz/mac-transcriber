/**
 * Per-file speaker hints for tree mode.
 *
 * A real archive is not homogeneous: the run this was built for held 70-minute
 * five-person panels next to 8-minute solo market updates in the same tree.
 * One `--speakers` value for the whole walk is wrong for half the files, and
 * splitting the run per subfolder defeats the point of walking a tree.
 *
 * The format is deliberately tiny — one glob, one set of speaker flags, first
 * match wins — because the alternative (a config file format with its own
 * schema) is far more machinery than "which of these three shapes is this
 * file" deserves.
 */

/** Speaker flags a rule may set. Nothing else is accepted — see parseHints. */
export interface SpeakerHintFlags {
  speakers: number | null;
  minSpeakers: number | null;
  maxSpeakers: number | null;
}

export interface HintRule {
  glob: string;
  pattern: RegExp;
  flags: SpeakerHintFlags;
  /** 1-based source line, so parse errors can point at it. */
  line: number;
}

/**
 * Converts a shell-style glob to an anchored RegExp supporting `*`, `?` and
 * `[...]` classes.
 *
 * Hand-rolled rather than using `path.matchesGlob`, which is still flagged
 * experimental and would print a runtime warning mid-batch, and rather than
 * adding a dependency for twenty lines. Every other character is escaped, so
 * `.` in `*.wav` matches a literal dot rather than any character.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if (ch === "[") {
      // Copy the class through verbatim up to the closing bracket. An
      // unterminated class is treated as a literal '[' rather than throwing —
      // a typo in a hints file should not abort a 43-file run.
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        out += glob.slice(i, close + 1);
        i = close;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const FLAG_KEYS: Record<string, keyof SpeakerHintFlags> = {
  "--speakers": "speakers",
  "--min-speakers": "minSpeakers",
  "--max-speakers": "maxSpeakers",
};

function parseFlags(tokens: string[], line: number): SpeakerHintFlags {
  const flags: SpeakerHintFlags = { speakers: null, minSpeakers: null, maxSpeakers: null };
  for (let i = 0; i < tokens.length; i++) {
    const key = FLAG_KEYS[tokens[i]!];
    if (!key) {
      // Rejecting unknown flags loudly beats silently ignoring them: a typo'd
      // `--speaker 5` that parsed as "no hint" would quietly mis-diarize every
      // file the rule was written for.
      throw new Error(
        `hints line ${line}: unsupported flag "${tokens[i]}" (only --speakers, --min-speakers, --max-speakers)`,
      );
    }
    const raw = tokens[++i];
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < 1) {
      throw new Error(
        `hints line ${line}: ${tokens[i - 1]} needs a positive whole number, got "${raw ?? ""}"`,
      );
    }
    flags[key] = n;
  }
  if (
    flags.minSpeakers !== null &&
    flags.maxSpeakers !== null &&
    flags.minSpeakers > flags.maxSpeakers
  ) {
    throw new Error(`hints line ${line}: --min-speakers must be <= --max-speakers`);
  }
  return flags;
}

/**
 * Parses a hints file. Blank lines and `#` comments are ignored; every other
 * line is `<glob>` whitespace `<flags…>`.
 */
export function parseHints(contents: string): HintRule[] {
  const rules: HintRule[] = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.replace(/#.*$/, "").trim();
    if (stripped === "") continue;
    // Split at the first whitespace-then-flag boundary, NOT on whitespace
    // generally: real recording names are full of spaces ("Kim Winters Market
    // Update.wav"), so a glob like `*Market Update*` must survive intact.
    // Splitting on plain whitespace silently reads "Update*" as a flag.
    const split = stripped.match(/^(.+?)\s+(--\S[\s\S]*)$/);
    if (!split) {
      throw new Error(
        `hints line ${i + 1}: "${stripped}" has no flags (expected "<glob> --speakers <n>")`,
      );
    }
    const glob = split[1]!;
    const tokens = split[2]!.split(/\s+/);
    rules.push({
      glob,
      pattern: globToRegExp(glob),
      flags: parseFlags(tokens, i + 1),
      line: i + 1,
    });
  }
  return rules;
}

/**
 * First matching rule wins, so a hints file reads top-down like a routing
 * table: specific patterns first, a `*` catch-all last. Returns null when
 * nothing matches, which callers treat as "use the CLI's own flags".
 *
 * `relativePath` is relative to the walk root (and always `/`-separated), so a
 * rule whose glob contains a slash — star, slash, `RR.wav` — is folder-aware.
 * (Spelled out rather than written literally: that character sequence would
 * close this block comment.)
 */
export function matchHint(rules: HintRule[], relativePath: string): HintRule | null {
  return rules.find((rule) => rule.pattern.test(relativePath)) ?? null;
}
