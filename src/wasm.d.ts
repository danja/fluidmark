/**
 * src/wasm.d.ts
 *
 * Types for the JavaScript wrapper, not for the raw `core_*` exports. Host code works with
 * these, so a call site cannot get an argument order wrong, and the raw surface stays
 * something only this wrapper touches.
 */

/** A buffer held by the core. The pointer is not exposed; create and destroy go through the core. */
export interface CoreBuffer {
  readonly ptr: number;
  readonly capacity: number;
  /** Samples currently marked valid in the core. */
  length: number;
  readonly data: number;
}

/** The wrapper around one instantiated core module. */
export interface Core {
  abiVersion(): number;
  readonly memory: WebAssembly.Memory;
  createBuffer(capacity: number): CoreBuffer;
  destroyBuffer(buffer: CoreBuffer): void;
  /** A view over a buffer's samples, at most its capacity. Derived per call, never cached. */
  samples(buffer: CoreBuffer, length?: number): Float32Array;
  writeBuffer(buffer: CoreBuffer, input: Float32Array): void;
  readBuffer(buffer: CoreBuffer): Float32Array;
  trackedLength(buffer: CoreBuffer): number;
  /** The capacity the core has recorded. Must always equal the capacity that was requested. */
  trackedCapacity(buffer: CoreBuffer): number;
  goertzelPower(buffer: CoreBuffer, freq: number, sampleRate: number): number;
  /** Samples one copy of a spread-spectrum mark needs for a frame of `frameBytes`. */
  ssMinSamples(frameBytes: number, sampleRate: number): number;
  /** Mark audio, returning a new array. `key` is `splitKey` output. */
  ssEmbed(audio: Float32Array, frame: Uint8Array, key: { lo: number; hi: number }, sampleRate: number, strengthDb: number): Float32Array;
  /**
   * Look for a spread-spectrum mark. `frame` is the bytes as read and is not to be believed unless
   * `status` is `'verified'`.
   */
  ssDetect(audio: Float32Array, key: { lo: number; hi: number }, sampleRate: number): {
    status: 'verified' | 'damaged' | 'none';
    frame: Uint8Array;
    confidence: number;
  };
  destroy(): void;
}

/** Wrap an instantiated core module. Refuses a module whose ABI version is not expected. */
export function createCore(instance: WebAssembly.Instance): Core;

/** The ABI version this wrapper was written against. */
export const ABI_VERSION_EXPECTED: number;

/** A `Float32Array` over `len` samples at byte offset `ptr`. Never cache one across a grow. */
export function floatView(memory: WebAssembly.Memory, ptr: number, len: number): Float32Array;

/** A one-element `Float64Array` over an out-parameter the core wrote. */
export function doubleOut(memory: WebAssembly.Memory, ptr: number): Float64Array;

/** A one-element `Uint32Array` over an integer out-parameter. */
export function uint32Out(memory: WebAssembly.Memory, ptr: number): Uint32Array;

/** True when `view` is looking at a detached buffer, which reports zero length rather than throwing. */
export function isDetached(view: ArrayBufferView): boolean;

/** Grow the core's memory. Detaches every existing view; returns the previous page count. */
export function growMemory(memory: WebAssembly.Memory, pages?: number): number;