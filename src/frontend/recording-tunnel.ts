import Guacamole from "guacamole-common-js";

/**
 * Feeds a saved recording to Guacamole.SessionRecording. Its Blob constructor
 * is broken in guacamole-common-js 1.5.0, the newest on npm: it reads a variable
 * it never sets. The tunnel path works, so the file goes through that.
 */
export function createRecordingTunnel(blob: Blob): Guacamole.Tunnel {
  const tunnel = new Guacamole.Tunnel();
  let stopped = false;

  tunnel.connect = () => {
    const parser = new Guacamole.Parser();
    parser.oninstruction = (opcode: string, args: string[]) => {
      if (!stopped) tunnel.oninstruction?.(opcode, args);
    };
    const reader = blob
      .stream()
      .pipeThrough(new TextDecoderStream())
      .getReader();
    tunnel.setState(Guacamole.Tunnel.State.OPEN);
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        parser.receive(value);
      }
    };
    pump()
      .catch((error: unknown) => {
        tunnel.onerror?.(
          new Guacamole.Status(
            Guacamole.Status.Code.SERVER_ERROR,
            error instanceof Error ? error.message : String(error),
          ),
        );
      })
      .finally(() => tunnel.setState(Guacamole.Tunnel.State.CLOSED));
  };
  tunnel.disconnect = () => {
    stopped = true;
  };
  tunnel.sendMessage = () => {};
  return tunnel;
}
