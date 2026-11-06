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

describe("timestamped output-event transcripts", () => {
  it("uses the server start with millisecond precision and preserves event boundaries", () => {
    const cast = parseAsciicast(
      source([
        [0, "o", "hel"],
        [0.125, "o", "lo\r\nsecond line\n"],
        [1, "i", "secret input"],
        [2, "r", "100x40"],
        [2.001, "o", "尾部"],
      ]),
      true,
    );
    expect(asciicastToTimestampedText(cast, start)).toBe(
      '[2026-11-06T12:00:00.123Z] "hel"\n' +
        '[2026-11-06T12:00:00.248Z] "lo\\r\\nsecond line\\n"\n' +
        '[2026-11-06T12:00:02.124Z] "尾部"',
    );
  });

  it("escapes progress updates, split ANSI, OSC and directional controls without losing payload", () => {
    const chunks = [
      "\r50%\b",
      "\x1b[",
      "31mred\x1b[0m",
      "\x1b]52;c;data\x07",
      "汉字🙂\u202e\u009b\u2028\0",
    ];
    const text = asciicastToTimestampedText(
      parseAsciicast(source(chunks.map((chunk, i) => [i, "o", chunk])), true),
      start,
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(chunks.length);
    expect(
      lines.map((line) => JSON.parse(line.slice(line.indexOf("] ") + 2))),
    ).toEqual(chunks);
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028-\u202e]/);
    expect(text).toContain("汉字🙂\\u202e\\u009b\\u2028\\u0000");
  });

  it("normalizes an explicit offset to UTC", () => {
    expect(
      asciicastToTimestampedText(
        parseAsciicast(source([[0.5, "o", "ok"]])),
        "2026-11-06T20:00:00.123+08:00",
      ),
    ).toBe('[2026-11-06T12:00:00.623Z] "ok"');
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
