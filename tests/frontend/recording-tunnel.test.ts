import Guacamole from "guacamole-common-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createRecordingTunnel } from "../../src/frontend/recording-tunnel";

const encode = (...parts: Array<string | number>) =>
  parts.map((part) => `${String(part).length}.${part}`).join(",") + ";";

const text =
  encode("size", 0, 1920, 1080) +
  encode("rect", 0, 0, 0, 1920, 1080) +
  encode("sync", 1000) +
  encode("sync", 3000);

const fileOf = (content: string) =>
  ({ stream: () => new Response(content).body }) as unknown as Blob;

// jsdom has no 2d canvas without the native canvas package
const fakeContext = () =>
  new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    fakeContext()) as unknown as HTMLCanvasElement["getContext"];
});

describe("createRecordingTunnel", () => {
  it("loads a saved recording through the real SessionRecording", async () => {
    const recording = new Guacamole.SessionRecording(
      createRecordingTunnel(fileOf(text)),
    );
    const loaded = new Promise<void>((resolve, reject) => {
      recording.onload = () => resolve();
      recording.onerror = reject;
    });
    recording.connect();
    await loaded;
    expect(recording.getDuration()).toBe(2000);
  });

  it("stops feeding instructions after a disconnect", async () => {
    const tunnel = createRecordingTunnel(fileOf(text));
    const opcodes: string[] = [];
    tunnel.oninstruction = (opcode: string) => {
      opcodes.push(opcode);
    };
    const closed = new Promise<void>((resolve) => {
      tunnel.onstatechange = (state: number) => {
        if (state === Guacamole.Tunnel.State.CLOSED) resolve();
      };
    });
    tunnel.connect();
    tunnel.disconnect();
    await closed;
    expect(opcodes).toEqual([]);
  });
});
