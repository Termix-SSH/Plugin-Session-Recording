import { Terminal } from "@xterm/xterm";

type AsciicastEvent = [time: number, type: "i" | "o" | "r", data: string];

export type Asciicast = {
  width: number;
  height: number;
  duration: number;
  events: AsciicastEvent[];
};

export class RecordingTimeError extends Error {}

export function parseAsciicast(
  source: string,
  requireValidTimes = false,
): Asciicast {
  const lines = source.trim().split("\n");
  const header = JSON.parse(lines.shift() || "{}") as {
    version?: number;
    width?: number;
    height?: number;
  };
  if (header.version !== 2) throw new Error("Unsupported asciicast version");

  const events = lines
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as AsciicastEvent;
      if (
        requireValidTimes &&
        event[1] === "o" &&
        (!Number.isFinite(event[0]) || event[0] < 0)
      ) {
        throw new RecordingTimeError("Invalid output event time");
      }
      return event;
    })
    .filter(
      ([time, type, data]) =>
        Number.isFinite(time) &&
        (type === "i" || type === "o" || type === "r") &&
        typeof data === "string",
    );

  return {
    width: header.width || 80,
    height: header.height || 24,
    duration: events.at(-1)?.[0] || 0,
    events,
  };
}

function writeAsync(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

// Replays the recording into an offscreen terminal and reads back its
// rendered buffer, so cursor movement/overwrites resolve the same way
// they would on screen instead of leaving raw ANSI escapes in the text.
export async function asciicastToPlainText(
  recording: Asciicast,
): Promise<string> {
  const terminal = new Terminal({
    cols: recording.width,
    rows: recording.height,
    allowProposedApi: true,
  });

  try {
    for (const [, type, data] of recording.events) {
      if (type === "o") await writeAsync(terminal, data);
      if (type === "r") {
        const [cols, rows] = data.split("x").map(Number);
        if (cols > 0 && rows > 0) terminal.resize(cols, rows);
      }
    }

    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    return lines.join("\n");
  } finally {
    terminal.dispose();
  }
}

// Escape sequences (CSI, OSC, two byte) and other control characters.
const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\^_]|\x9b[0-?]*[ -/]*[@-~]/g;
const ESCAPE_START = new RegExp(`^(?:${ESCAPES.source})`);
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g;

/**
 * One line per line of output, stamped with the UTC time its first character
 * reached the recorder. Times are output arrival, not command execution.
 */
export function asciicastToTimestampedText(
  recording: Asciicast,
  startedAt: string,
): string {
  const start = Date.parse(startedAt);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(startedAt) || !Number.isFinite(start)) {
    throw new RecordingTimeError("Missing recording start time");
  }
  const out: string[] = [];
  let line = "";
  let lineAt: number | null = null;
  // An escape split across two events is held until the next one.
  let pending = "";
  const flush = () => {
    if (lineAt !== null)
      out.push(`[${new Date(lineAt).toISOString()}] ${line.trimEnd()}`);
    line = "";
    lineAt = null;
  };
  for (const [offset, type, data] of recording.events) {
    if (type !== "o") continue;
    const time = start + Math.round(offset * 1000);
    if (
      !Number.isFinite(offset) ||
      offset < 0 ||
      !Number.isFinite(new Date(time).getTime())
    ) {
      throw new RecordingTimeError("Invalid output event time");
    }
    let text = pending + data;
    const cut = text.search(/\x1b[^\x07]*$/);
    pending =
      cut >= 0 && !ESCAPE_START.test(text.slice(cut)) ? text.slice(cut) : "";
    if (pending) text = text.slice(0, cut);
    // A \r at the end may be the first half of \r\n.
    else if (text.endsWith("\r")) {
      pending = "\r";
      text = text.slice(0, -1);
    }
    for (const part of text.replace(ESCAPES, "").split(/(\r\n|\n|\r|\x08)/)) {
      if (part === "\n" || part === "\r\n") {
        if (lineAt === null) lineAt = time;
        flush();
      } else if (part === "\r") {
        // A bare carriage return redraws the line, like a progress bar.
        line = "";
      } else if (part === "\b") {
        line = line.slice(0, -1);
      } else if (part) {
        if (lineAt === null) lineAt = time;
        line += part.replace(CONTROLS, "");
      }
    }
  }
  flush();
  return out.join("\n");
}
