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

// An event transcript, not a reconstructed screen or a command execution log.
export function asciicastToTimestampedText(
  recording: Asciicast,
  startedAt: string,
): string {
  const start = Date.parse(startedAt);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(startedAt) || !Number.isFinite(start)) {
    throw new RecordingTimeError("Missing recording start time");
  }
  return recording.events
    .filter(([, type]) => type === "o")
    .map(([offset, , data]) => {
      const time = start + Math.round(offset * 1000);
      if (
        !Number.isFinite(offset) ||
        offset < 0 ||
        !Number.isFinite(new Date(time).getTime())
      ) {
        throw new RecordingTimeError("Invalid output event time");
      }
      const text = JSON.stringify(data).replace(
        /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      return `[${new Date(time).toISOString()}] ${text}`;
    })
    .join("\n");
}
