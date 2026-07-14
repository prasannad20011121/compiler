/**
 * Synchronous stdin for WASM runtimes, shared by the Python and C/C++ workers.
 *
 * SharedArrayBuffer layout:
 *   Int32Array[0] — state: 0 idle, 1 line requested, 2 line ready
 *   Int32Array[1] — payload byte length
 *   bytes 8..     — UTF-8 payload
 *
 * The worker blocks in Atomics.wait while the main thread collects a line
 * from the terminal, writes it into the buffer, and notifies.
 */
export const STDIN_STATE = { IDLE: 0, REQUESTED: 1, READY: 2 } as const;
export const STDIN_HEADER_BYTES = 8;
export const STDIN_PAYLOAD_BYTES = 64 * 1024;
export const STDIN_SAB_BYTES = STDIN_HEADER_BYTES + STDIN_PAYLOAD_BYTES;

/** Worker side: blocks until the main thread delivers a line (without trailing newline). */
export class StdinBridge {
  private readonly state: Int32Array;
  private readonly payload: Uint8Array;

  constructor(sab: SharedArrayBuffer) {
    this.state = new Int32Array(sab, 0, 2);
    this.payload = new Uint8Array(sab, STDIN_HEADER_BYTES);
  }

  readLine(): string {
    Atomics.store(this.state, 1, 0);
    Atomics.store(this.state, 0, STDIN_STATE.REQUESTED);
    self.postMessage({ type: 'stdin-request' });
    Atomics.wait(this.state, 0, STDIN_STATE.REQUESTED);
    const length = Atomics.load(this.state, 1);
    const text = new TextDecoder().decode(this.payload.slice(0, length));
    Atomics.store(this.state, 0, STDIN_STATE.IDLE);
    return text;
  }
}

/** Main-thread side: deliver a collected line and wake the blocked worker. */
export function deliverStdinLine(sab: SharedArrayBuffer, line: string): void {
  const state = new Int32Array(sab, 0, 2);
  const payload = new Uint8Array(sab, STDIN_HEADER_BYTES);
  const bytes = new TextEncoder().encode(line).slice(0, STDIN_PAYLOAD_BYTES);
  payload.set(bytes);
  Atomics.store(state, 1, bytes.length);
  Atomics.store(state, 0, STDIN_STATE.READY);
  Atomics.notify(state, 0);
}
