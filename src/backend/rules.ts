/**
 * Command alert rules. Each SSH recording gets a scanner that reads the
 * asciicast lines the terminal appends ("i" for input, "o" for output),
 * turns them into plain text lines and checks every enabled rule. Matching
 * happens in memory as chunks arrive, before they are encrypted.
 */

export type RuleTarget = "input" | "output";
export type RuleHosts = "all" | "privileged";
export type RuleSeverity = "info" | "warning" | "critical";
export type RuleAction = "alert" | "end";

export interface Rule {
  id: number;
  name: string;
  pattern: string;
  regex: boolean;
  target: RuleTarget;
  hosts: RuleHosts;
  severity: RuleSeverity;
  action: RuleAction;
  enabled: boolean;
}

export interface RuleMatch {
  /** Seconds into the recording. */
  t: number;
  ruleId: number;
  name: string;
  severity: RuleSeverity;
  action: RuleAction;
  /** The matched line, cut short. */
  text: string;
}

const MAX_LINE = 4096;
const MAX_TEXT = 200;
export const MAX_PATTERN = 300;

/** A pattern that nests a repeat inside a repeat can hang the matcher. */
const RISKY_REGEX = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

/** Throws a plain message for a pattern that can't be used. */
export function checkPattern(pattern: string, regex: boolean): void {
  if (!pattern.trim()) throw new Error("The pattern is empty");
  if (pattern.length > MAX_PATTERN) throw new Error("The pattern is too long");
  if (!regex) return;
  if (RISKY_REGEX.test(pattern)) {
    throw new Error("That pattern is too complex");
  }
  try {
    new RegExp(pattern);
  } catch {
    throw new Error("That is not a valid regular expression");
  }
}

function matcher(rule: Rule): (line: string) => boolean {
  if (rule.regex) {
    const re = new RegExp(rule.pattern, "i");
    return (line) => re.test(line);
  }
  const needle = rule.pattern.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

// CSI, OSC and other escape sequences, then leftover control characters.
// eslint-disable-next-line no-control-regex
const ESCAPES =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, "").replace(CONTROLS, "");
}

/** Builds input lines from keystrokes: Enter ends a line, backspace edits it. */
export class InputLines {
  private line = "";

  push(data: string): string[] {
    const done: string[] = [];
    const clean = data.replace(ESCAPES, "");
    for (const char of clean) {
      if (char === "\r" || char === "\n") {
        if (this.line.trim()) done.push(this.line);
        this.line = "";
      } else if (char === "\x7f" || char === "\b") {
        this.line = this.line.slice(0, -1);
      } else if (char === "\x03" || char === "\x15") {
        // Ctrl+C and Ctrl+U drop the line.
        this.line = "";
      } else if (char >= " ") {
        if (this.line.length < MAX_LINE) this.line += char;
      }
    }
    return done;
  }
}

/** Splits output into whole lines. */
export class OutputLines {
  private line = "";

  push(data: string): string[] {
    const parts = (this.line + data).split(/\r?\n/);
    this.line = (parts.pop() ?? "").slice(-MAX_LINE);
    return parts.map(stripAnsi).filter((part) => part.trim());
  }
}

interface CompiledRule {
  rule: Rule;
  test: (line: string) => boolean;
}

/** One scanner per recording. */
export class RecordingScanner {
  private readonly input = new InputLines();
  private readonly output = new OutputLines();
  private partial = "";
  private readonly rules: CompiledRule[];

  constructor(rules: Rule[]) {
    this.rules = rules
      .filter((rule) => rule.enabled)
      .flatMap((rule) => {
        try {
          return [{ rule, test: matcher(rule) }];
        } catch {
          return [];
        }
      });
  }

  get empty(): boolean {
    return this.rules.length === 0;
  }

  /** Reads one appended chunk of asciicast lines. */
  scan(chunk: string): RuleMatch[] {
    if (this.rules.length === 0) return [];
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    const matches: RuleMatch[] = [];
    for (const raw of lines) {
      if (!raw.startsWith("[")) continue;
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(event) || typeof event[2] !== "string") continue;
      const [time, type, data] = event as [number, string, string];
      const target: RuleTarget | null =
        type === "i" ? "input" : type === "o" ? "output" : null;
      if (!target) continue;
      const texts =
        target === "input" ? this.input.push(data) : this.output.push(data);
      for (const text of texts) {
        for (const { rule, test } of this.rules) {
          if (rule.target !== target || !test(text)) continue;
          matches.push({
            t: Number(time) || 0,
            ruleId: rule.id,
            name: rule.name,
            severity: rule.severity,
            action: rule.action,
            text: text.slice(0, MAX_TEXT),
          });
        }
      }
    }
    return matches;
  }
}

/** Rules a new install starts with, all off. */
export const STARTER_RULES: Array<Omit<Rule, "id" | "enabled">> = [
  {
    name: "Delete the root folder",
    pattern: "rm\\s+-[a-z]*r[a-z]*f?[a-z]*\\s+/(\\s|$)",
    regex: true,
    target: "input",
    hosts: "all",
    severity: "critical",
    action: "alert",
  },
  {
    name: "Switch to root",
    pattern: "sudo su",
    regex: false,
    target: "input",
    hosts: "all",
    severity: "warning",
    action: "alert",
  },
  {
    name: "Change a password",
    pattern: "^\\s*(sudo\\s+)?passwd\\b",
    regex: true,
    target: "input",
    hosts: "all",
    severity: "warning",
    action: "alert",
  },
  {
    name: "Pipe a download into a shell",
    pattern: "(curl|wget)[^|]*\\|\\s*(sudo\\s+)?(ba|z)?sh\\b",
    regex: true,
    target: "input",
    hosts: "all",
    severity: "critical",
    action: "alert",
  },
  {
    name: "Clear shell history",
    pattern: "history -c",
    regex: false,
    target: "input",
    hosts: "all",
    severity: "warning",
    action: "alert",
  },
  {
    name: "Open file permissions to everyone",
    pattern: "chmod\\s+(-R\\s+)?777",
    regex: true,
    target: "input",
    hosts: "all",
    severity: "warning",
    action: "alert",
  },
  {
    name: "Flush firewall rules",
    pattern: "iptables\\s+-F",
    regex: true,
    target: "input",
    hosts: "all",
    severity: "critical",
    action: "alert",
  },
  {
    name: "Delete a user",
    pattern: "^\\s*(sudo\\s+)?userdel\\b",
    regex: true,
    target: "input",
    hosts: "all",
    severity: "warning",
    action: "alert",
  },
];
