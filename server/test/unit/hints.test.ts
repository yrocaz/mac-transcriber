import { describe, expect, it } from "vitest";
import { globToRegExp, matchHint, parseHints } from "../../src/hints";

describe("globToRegExp", () => {
  it("anchors the whole string so a partial match does not count", () => {
    expect(globToRegExp("Panel").test("Panel")).toBe(true);
    expect(globToRegExp("Panel").test("Panel + QA")).toBe(false);
  });

  it("treats * as any run of characters, including path separators", () => {
    expect(globToRegExp("*Panel*").test("Next Deal Edit/Panel.wav")).toBe(true);
    expect(globToRegExp("*/RR.wav").test("Next Deal Edit/RR.wav")).toBe(true);
  });

  it("treats ? as exactly one character", () => {
    expect(globToRegExp("a?c.wav").test("abc.wav")).toBe(true);
    expect(globToRegExp("a?c.wav").test("ac.wav")).toBe(false);
  });

  it("supports [...] classes, which is how case-insensitive names are written", () => {
    const pattern = globToRegExp("*[Pp]anel*");
    expect(pattern.test("4th affordable edit/Panel.wav")).toBe(true);
    expect(pattern.test("Finding Money Edit/panel.wav")).toBe(true);
    expect(pattern.test("Finding Money Edit/Tariffs.wav")).toBe(false);
  });

  it("escapes dots so *.wav does not match arbitrary characters", () => {
    expect(globToRegExp("*.wav").test("Panel.wav")).toBe(true);
    expect(globToRegExp("*.wav").test("PanelXwav")).toBe(false);
  });

  it("treats an unterminated [ as a literal rather than throwing mid-batch", () => {
    expect(() => globToRegExp("Panel[.wav")).not.toThrow();
    expect(globToRegExp("Panel[.wav").test("Panel[.wav")).toBe(true);
  });
});

describe("parseHints", () => {
  it("ignores comments and blank lines", () => {
    const rules = parseHints("# a comment\n\n*Panel*  --speakers 5\n   \n");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.glob).toBe("*Panel*");
    expect(rules[0]!.flags).toEqual({ speakers: 5, minSpeakers: null, maxSpeakers: null });
  });

  it("strips trailing comments from a rule line", () => {
    const rules = parseHints("*Panel*  --speakers 5   # panels always have five\n");
    expect(rules[0]!.flags.speakers).toBe(5);
  });

  it("parses a min/max range", () => {
    const rules = parseHints("*Intro*  --min-speakers 1 --max-speakers 2");
    expect(rules[0]!.flags).toEqual({ speakers: null, minSpeakers: 1, maxSpeakers: 2 });
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    // A typo'd --speaker that parsed as "no hint" would quietly mis-diarize
    // every file the rule was written for.
    expect(() => parseHints("*Panel*  --speaker 5")).toThrow(/line 1.*--speaker/);
  });

  it("rejects a non-numeric or zero speaker count, naming the line", () => {
    expect(() => parseHints("\n*Panel*  --speakers many")).toThrow(/line 2/);
    expect(() => parseHints("*Panel*  --speakers 0")).toThrow(/positive whole number/);
  });

  it("rejects an inverted range", () => {
    expect(() => parseHints("*  --min-speakers 5 --max-speakers 2")).toThrow(/must be <=/);
  });

  it("rejects a glob with no flags", () => {
    expect(() => parseHints("*Panel*")).toThrow(/has no flags/);
  });
});

describe("matchHint", () => {
  // The rules file from the archive run this feature was built for.
  const rules = parseHints(
    [
      "*[Pp]anel*        --speakers 5",
      "*Market Update*   --min-speakers 1 --max-speakers 2",
      "*Intro*           --min-speakers 1 --max-speakers 2",
      "*/RR.wav          --min-speakers 1 --max-speakers 2",
      "*                 --speakers 5",
    ].join("\n"),
  );

  it("routes each archive shape to the flags it needs", () => {
    expect(matchHint(rules, "4th affordable edit/Panel.wav")!.flags.speakers).toBe(5);
    expect(matchHint(rules, "24 Year In Review - Edit/Kim Winters Market Update.wav")!.flags).toEqual({
      speakers: null,
      minSpeakers: 1,
      maxSpeakers: 2,
    });
    expect(matchHint(rules, "Mastering Leads/Intro.wav")!.flags.maxSpeakers).toBe(2);
    expect(matchHint(rules, "Next Deal Edit/RR.wav")!.flags.maxSpeakers).toBe(2);
  });

  it("falls through to the catch-all for a long unlabelled recording", () => {
    const rule = matchHint(rules, "2023 Year in Review.mp3")!;
    expect(rule.glob).toBe("*");
    expect(rule.flags.speakers).toBe(5);
  });

  it("takes the first matching rule, not the most specific", () => {
    // "Panel + QA.wav" matches both *[Pp]anel* and the trailing catch-all;
    // order in the file is what decides, which is what makes a hints file
    // readable top-down like a routing table.
    expect(matchHint(rules, "WNC STR Edit/Panel + QA.wav")!.glob).toBe("*[Pp]anel*");
  });

  it("returns null when nothing matches, so callers can fall back to CLI flags", () => {
    expect(matchHint(parseHints("*Panel*  --speakers 5"), "Intro.wav")).toBeNull();
  });
});
