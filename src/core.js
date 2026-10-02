// src/core.js
//
// The wrapper around an instantiated core module. This is where the ergonomics live: typed
// arrays instead of pointers, an object instead of new and free pairs, and real errors
// instead of return codes. Host code should never call a `core_*` export directly.
//
// Takes an already-instantiated instance rather than fetching anything, so this module is the
// same on both sides and the Node and browser entry points only differ in how they load.
// See docs/ffi.md.

import { doubleOut, floatView } from './memory.js';

/** Error codes from the core, mapped to names a caller can read. */
const ERRORS = new Map([
  [-1, 'CoreNullError'],
  [-2, 'CoreLengthError'],
  [-3, 'CoreRangeError'],
  [-4, 'CoreMagicError'],
]);

/** The ABI this wrapper was written against. The core is checked against it on creation. */
export const ABI_VERSION_EXPECTED = 1;

/** Turn a negative core return into a thrown Error naming the operation and the reason. */
function check(code, operation) {
  if (code === 0) return;
  const reason = ERRORS.get(code) ?? 'CoreError';
  throw new Error(`${operation} failed: ${reason} (code ${code})`);
}

/**
 * Wrap an instantiated core module.
 *
 * `instance.exports` must expose `memory` and the `core_*` functions.
 */
export function createCore(instance) {
  const e = instance.exports;
  const memory = e.memory;
  if (!memory || typeof memory.buffer !== 'object') {
    throw new Error('core module has no exported memory');
  }
  if (typeof e.core_abi_version !== 'function') {
    throw new Error('core module has no core_abi_version; is this the right file?');
  }

  const got = e.core_abi_version();
  if (got !== ABI_VERSION_EXPECTED) {
    throw new Error(
      `core ABI version ${got}, expected ${ABI_VERSION_EXPECTED}; run npm run build`,
    );
  }

  // One scratch slot per core instance, for out-parameters. Held in this closure rather than
  // in a module global so two cores in one process do not share an address.
  const scratch = e.core_scratch_new();
  if (scratch === 0) {
    throw new Error('core_scratch_new returned null');
  }

  /**
   * A buffer, as an opaque handle. The pointer never leaves this module, so no caller can
   * invent an offset, free the same buffer twice, or read past the end by accident.
   */
  function createBuffer(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError(`capacity must be a positive integer, got ${capacity}`);
    }
    const ptr = e.core_buffer_new(capacity);
    if (ptr === 0) {
      throw new Error(`core_buffer_new refused a capacity of ${capacity}`);
    }
    return { ptr, capacity, data: e.core_buffer_data(ptr), length: 0 };
  }

  function destroyBuffer(buffer) {
    if (!buffer || typeof buffer.ptr !== 'number' || buffer.ptr === 0) {
      throw new TypeError('destroyBuffer needs a live buffer from createBuffer');
    }
    check(e.core_buffer_free(buffer.ptr), 'core_buffer_free');
    buffer.ptr = 0;
    buffer.data = 0;
    buffer.capacity = 0;
    buffer.length = 0;
  }

  /** A view over a buffer's samples, at most its capacity. Derived per call, never cached. */
  function samples(buffer, length = buffer.capacity) {
    return floatView(memory, buffer.data, length);
  }

  /**
   * Copy samples in and make them the buffer's tracked length.
   *
   * Writes in place through a view over the core's memory, then tells the core how many
   * samples are valid. The core refuses a length past the capacity.
   */
  function writeBuffer(buffer, input) {
    if (!buffer || buffer.ptr === 0) {
      throw new TypeError('writeBuffer needs a live buffer');
    }
    if (input.length > buffer.capacity) {
      throw new RangeError(
        `${input.length} samples into a buffer of capacity ${buffer.capacity}`,
      );
    }
    samples(buffer, input.length).set(input);
    check(e.core_buffer_set_len(buffer.ptr, input.length), 'core_buffer_set_len');
    buffer.length = input.length;
  }

  /** The tracked length out as a fresh `Float32Array`, copied so it outlives the core call. */
  function readBuffer(buffer) {
    if (!buffer || buffer.ptr === 0) {
      throw new TypeError('readBuffer needs a live buffer');
    }
    const out = new Float32Array(buffer.length);
    if (buffer.length > 0) {
      out.set(samples(buffer, buffer.length));
    }
    return out;
  }

  /** The length the core has recorded, rather than the one this wrapper believes. */
  function trackedLength(buffer) {
    if (!buffer || buffer.ptr === 0) {
      throw new TypeError('trackedLength needs a live buffer');
    }
    check(e.core_buffer_len(buffer.ptr, scratch), 'core_buffer_len');
    return new Uint32Array(memory.buffer, scratch, 1)[0];
  }

  /**
   * The capacity the core has recorded, rather than the one this wrapper believes.
   *
   * These two must always agree. A divergence means something has written over a buffer
   * header, which in practice means an out-parameter landed in the wrong place.
   */
  function trackedCapacity(buffer) {
    if (!buffer || buffer.ptr === 0) {
      throw new TypeError('trackedCapacity needs a live buffer');
    }
    check(e.core_buffer_capacity(buffer.ptr, scratch), 'core_buffer_capacity');
    return new Uint32Array(memory.buffer, scratch, 1)[0];
  }

  /** Goertzel power at `freq`, over the buffer's tracked length. */
  function goertzelPower(buffer, freq, sampleRate) {
    if (!buffer || buffer.ptr === 0) {
      throw new TypeError('goertzelPower needs a live buffer');
    }
    check(
      e.core_goertzel_power(buffer.ptr, freq, sampleRate, scratch),
      'core_goertzel_power',
    );
    return doubleOut(memory, scratch)[0];
  }

  function destroy() {
    if (scratch !== 0) {
      e.core_scratch_free(scratch);
    }
  }

  return {
    abiVersion: () => e.core_abi_version(),
    memory,
    createBuffer,
    destroyBuffer,
    samples,
    writeBuffer,
    readBuffer,
    trackedLength,
    trackedCapacity,
    goertzelPower,
    destroy,
  };
}