import { canonicalUtf8, type JsonValue, validateJsonResources } from "./canonical.js";
import { IPC_FRAME_HEADER_BYTES, IPC_FRAME_MAX_FEED_CHUNK_BYTES, IPC_FRAME_MAX_PAYLOAD_BYTES, IPC_FRAME_MIN_PAYLOAD_BYTES } from "./generated-runtime-profiles.js";

export const FRAME_HEADER_BYTES = IPC_FRAME_HEADER_BYTES;
export const MIN_FRAME_PAYLOAD_BYTES = IPC_FRAME_MIN_PAYLOAD_BYTES;
export const MAX_FRAME_PAYLOAD_BYTES = IPC_FRAME_MAX_PAYLOAD_BYTES;
export const MAX_FEED_CHUNK_BYTES = IPC_FRAME_MAX_FEED_CHUNK_BYTES;

export class IpcFrameError extends Error {}

export function encodeFrame(value: unknown): Uint8Array {
  const payload = canonicalUtf8(value);
  if (payload.length < MIN_FRAME_PAYLOAD_BYTES || payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new IpcFrameError("canonical payload size is outside A620-IPC-FRAME-1 limits");
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

export function decodeCanonicalPayload(payload: Uint8Array): JsonValue {
  if (payload.length < MIN_FRAME_PAYLOAD_BYTES || payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new IpcFrameError("frame payload size is outside A620-IPC-FRAME-1 limits");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error) {
    throw new IpcFrameError(`frame payload is not valid UTF-8: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new IpcFrameError(`frame payload is not valid JSON: ${String(error)}`);
  }
  try {
    validateJsonResources(value);
  } catch (error) {
    throw new IpcFrameError(String(error));
  }
  const canonical = canonicalUtf8(value);
  if (!equalBytes(canonical, payload)) {
    throw new IpcFrameError("frame payload is not A620-JCS-1 canonical JSON");
  }
  return value;
}

/** Streaming decoder retaining only one partial header/payload. */
export class FrameDecoder {
  private readonly header = new Uint8Array(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private payload: Uint8Array | null = null;
  private payloadBytes = 0;
  private failed = false;

  private fail(message: string): never {
    this.failed = true;
    this.headerBytes = 0;
    this.payload = null;
    this.payloadBytes = 0;
    throw new IpcFrameError(message);
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    if (this.failed) throw new IpcFrameError("frame decoder is already failed");
    if (!(chunk instanceof Uint8Array)) this.fail("frame chunk must be Uint8Array");
    if (chunk.length > MAX_FEED_CHUNK_BYTES) this.fail("frame feed chunk exceeds A620-IPC-FRAME-1 limit");

    const frames: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === null) {
        const take = Math.min(FRAME_HEADER_BYTES - this.headerBytes, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + take), this.headerBytes);
        this.headerBytes += take;
        offset += take;
        if (this.headerBytes < FRAME_HEADER_BYTES) continue;
        const length = new DataView(this.header.buffer).getUint32(0, false);
        this.headerBytes = 0;
        if (length < MIN_FRAME_PAYLOAD_BYTES || length > MAX_FRAME_PAYLOAD_BYTES) {
          this.fail(`invalid frame payload length: ${length}`);
        }
        this.payload = new Uint8Array(length);
        this.payloadBytes = 0;
      }

      const payload = this.payload;
      const take = Math.min(payload.length - this.payloadBytes, chunk.length - offset);
      payload.set(chunk.subarray(offset, offset + take), this.payloadBytes);
      this.payloadBytes += take;
      offset += take;
      if (this.payloadBytes === payload.length) {
        frames.push(payload);
        this.payload = null;
        this.payloadBytes = 0;
      }
    }
    return frames;
  }

  get retainedBytes(): number {
    return this.headerBytes + this.payloadBytes;
  }

  finish(): void {
    if (this.failed) throw new IpcFrameError("frame decoder is already failed");
    if (this.headerBytes !== 0 || this.payload !== null || this.payloadBytes !== 0) {
      this.fail("channel closed with a trailing partial frame");
    }
  }
}
