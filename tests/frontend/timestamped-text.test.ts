import { describe, expect, it } from "vitest";
import {
  asciicastToTimestampedText,
  parseAsciicast,
  RecordingTimeError,
} from "../../src/frontend/asciicast";

const start = "2026-11-06T12:00:00.123Z";
const source = (events: unknown[]) =>
  [
    '{"version":2,"timestamp":1793966400}',
    ...events.map((e) => JSON.stringify(e)),
  ].join("\n");
const text = (events: unknown[], startedAt = start) =>
  asciicastToTimestampedText(parseAsciicast(source(events), true), startedAt);

describe("timestamped text downloads", () => {
  it("stamps each line with the time its first output arrived", () => {
    expect(
      text([
        [0, "o", "hel"],
        [0.125, "o", "lo\r\nsecond line\n"],
        [1, "i", "secret input"],
        [2, "r", "100x40"],
        [2.001, "o", "尾部"],
      ]),
    ).toBe(
      "[2026-11-06T12:00:00.123Z] hello\n" +
        "[2026-11-06T12:00:00.248Z] second line\n" +
        "[2026-11-06T12:00:02.124Z] 尾部",
    );
  });

  it("drops colors and escapes, even when split across output", () => {
    expect(
      text([
        [0, "o", "\x1b["],
        [0.5, "o", "31mred\x1b[0m \x1b]0;title\x07done\r"],
        [1, "o", "\n"],
      ]),
    ).toBe("[2026-11-06T12:00:00.623Z] red done");
  });

  it("keeps only the last state of a redrawn line and applies backspace", () => {
    expect(
      text([
        [0, "o", "10%\r50%\r100%\n"],
        [1, "o", "abx\bc\n"],
      ]),
    ).toBe("[2026-11-06T12:00:00.123Z] 100%\n[2026-11-06T12:00:01.123Z] abc");
  });

  it("removes control and direction characters", () => {
    const out = text([[0, "o", "汉字🙂‮\u009b \0ok"]]);
    expect(out).toBe("[2026-11-06T12:00:00.123Z] 汉字🙂ok");
  });

  it("normalizes an explicit offset to UTC", () => {
    expect(text([[0.5, "o", "ok"]], "2026-11-06T20:00:00.123+08:00")).toBe(
      "[2026-11-06T12:00:00.623Z] ok",
    );
  });

  it.each(["", "invalid", "2026-11-06T12:00:00"])(
    "rejects missing or ambiguous recording time %s",
    (startedAt) => {
      expect(() =>
        asciicastToTimestampedText(
          parseAsciicast(source([[0, "o", "x"]])),
          startedAt,
        ),
      ).toThrow(RecordingTimeError);
    },
  );

  it.each([-1, null, "1", 1e308])(
    "rejects invalid or out-of-range event offset %s",
    (offset) => {
      expect(() =>
        asciicastToTimestampedText(
          parseAsciicast(source([[offset, "o", "x"]]), true),
          start,
        ),
      ).toThrow(RecordingTimeError);
    },
  );

  it("does not require new timing fields in ordinary playback", () => {
    const cast = parseAsciicast('{"version":2}\n[0,"o","legacy"]');
    expect(cast.events).toEqual([[0, "o", "legacy"]]);
  });
});
