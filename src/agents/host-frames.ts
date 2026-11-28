/**
 * Frames on the socket between omem and an agent host (agent-host.ts): one type byte, a 4-byte
 * big-endian length, the payload. Node builtins only: the host process loads nothing else.
 *
 * omem → host: `i` the agent's stdin, `c` a control message (JSON: hello, kill, detach).
 * host → omem: `o` the agent's stdout (whole lines), `e` its stderr, `h` the answer to hello (JSON),
 * `x` the agent exited (JSON: code, signal, error).
 */
export const FRAME = { stdin: 0x69, control: 0x63, stdout: 0x6f, stderr: 0x65, hello: 0x68, exit: 0x78 } as const;

export function frame(type: number, payload: Buffer | string) {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const head = Buffer.allocUnsafe(5);
  head[0] = type;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream back into frames; anything over `max` bytes in one frame is a broken peer. */
export function frameReader(onFrame: (type: number, payload: Buffer) => void, max = 64 * 1024 * 1024) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 5) {
      const length = pending.readUInt32BE(1);
      if (length > max) throw new Error("帧太大");
      if (pending.length < 5 + length) break;
      const type = pending[0];
      const payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      onFrame(type, payload);
    }
  };
}

/** Splits text into lines; the last, unfinished one stays for the next chunk. */
export function lineReader(onLine: (line: string) => void, max = 64 * 1024 * 1024) {
  let pending = "";
  return (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      onLine(line);
    }
    if (pending.length > max) pending = "";
  };
}
