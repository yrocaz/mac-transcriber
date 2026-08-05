import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli";
import { DEFAULT_LOCALE } from "../../src/config";

describe("parseArgs", () => {
  it("defaults to diarized transcription in the configured locale", () => {
    const parsed = parseArgs(["Panel.wav"]);
    expect(parsed).toEqual({
      input: "Panel.wav",
      locale: DEFAULT_LOCALE,
      diarize: true,
      json: false,
      quiet: false,
    });
  });

  it("accepts flags in any order relative to the file", () => {
    expect(parseArgs(["--json", "a.wav", "--no-diarize"])).toMatchObject({
      input: "a.wav",
      diarize: false,
      json: true,
    });
  });

  it("reads --locale's value", () => {
    expect(parseArgs(["a.wav", "--locale", "es-ES"])).toMatchObject({ locale: "es-ES" });
  });

  it("rejects --locale with no value instead of swallowing the next flag", () => {
    expect(parseArgs(["a.wav", "--locale"])).toEqual({
      error: "--locale requires a value",
    });
  });

  it("rejects unknown options rather than treating them as the input path", () => {
    expect(parseArgs(["a.wav", "--turbo"])).toEqual({ error: "Unknown option: --turbo" });
  });

  it("rejects a missing input and a second positional argument", () => {
    expect(parseArgs([])).toEqual({ error: "Missing required <media-file> argument" });
    expect(parseArgs(["a.wav", "b.wav"])).toEqual({
      error: "Unexpected extra argument: b.wav",
    });
  });

  it("returns help for -h/--help before any validation", () => {
    expect(parseArgs(["-h"])).toEqual({ help: true });
    expect(parseArgs(["--help"])).toEqual({ help: true });
    // Help wins even with an otherwise-invalid argument list.
    expect(parseArgs(["--help", "--turbo"])).toEqual({ help: true });
  });
});
