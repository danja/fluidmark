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
export const ERRORS = new Map([
  [-1, 'CoreNullError'],
  [-2, 'CoreLengthError'],
  [-3, 'CoreRangeError'],
  [-4, 'CoreMagicError'],
]);

/** The ABI this wrapper was written against. The core is checked against it on creation. */
export const ABI_VERSION_EXPECTED = 1;

/** Samples of scratch the attack entry point needs; 65536 covers a second at 44.1 kHz. */
const ATTACK_SCRATCH = 65536;

/** The largest frame the format can carry: a header and a 16-bit length of payload. */
const SS_FRAME_CAPACITY = 10 + 0xffff;

/** Slack in an attack buffer, for attacks that lengthen the signal. */
const ATTACK_HEADROOM = 8192;

/**
 * Turn a negative core return into a thrown Error naming the operation and the reason.
 *
 * Exported because `bin/` reports a failure from a core call it made itself, and re-implementing
 * the mapping in a tool is how a caller ends up with two different names for the same fault.
 */
export function check(code, operation) {
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

  /**
   * The tracked length out as a fresh `Float32Array`, copied so it outlives the core call.
   *
   * Asks the core for the length rather than trusting this wrapper's copy. The two can diverge:
   * `core_encode` and `core_decode` both set the length on the core's side, and a wrapper that
   * read its own copy would report an empty result for a buffer the core had just filled.
   */
  function readBuffer(buffer) {
    if (!buffer || buffer.ptr === 0) {
      throw new TypeError('readBuffer needs a live buffer');
    }
    const length = trackedLength(buffer);
    const out = new Float32Array(length);
    if (length > 0) {
      out.set(samples(buffer, length));
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

  /**
   * Bytes in, tones out.
   *
   * The payload buffer holds bytes and the output buffer holds samples, so the two are sized
   * differently and read differently. The output capacity comes from the core rather than from a
   * guess here, because a guess one sample short loses the last character.
   */
  function encodeBytes(payload) {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError('encodeBytes needs a Uint8Array');
    }
    if (payload.length === 0) {
      throw new RangeError('nothing to encode');
    }
    const payloadBuffer = createBuffer(payload.length);
    try {
      fillBytes(payloadBuffer, payload);

      const capacity = e.core_encoded_size(payload.length);
      const toneBuffer = createBuffer(capacity);
      try {
        check(e.core_encode(payloadBuffer.ptr, toneBuffer.ptr), 'core_encode');
        return readBuffer(toneBuffer);
      } finally {
        destroyBuffer(toneBuffer);
      }
    } finally {
      destroyBuffer(payloadBuffer);
    }
  }

  /**
   * Tones in, bytes out.
   *
   * Returns null when there is no mark, which is a different thing from returning no bytes: the
   * caller has to be able to say "nothing here" rather than "an empty payload".
   */
  function decodeBytes(tones) {
    if (!(tones instanceof Float32Array)) {
      throw new TypeError('decodeBytes needs a Float32Array');
    }
    const toneBuffer = createBuffer(Math.max(1, tones.length));
    try {
      fillSamples(toneBuffer, tones);

      const capacity = e.core_decoded_size(tones.length);
      const outBuffer = createBuffer(Math.max(1, capacity));
      try {
        const code = e.core_decode(toneBuffer.ptr, outBuffer.ptr);
        if (code === -2) {
          return null;
        }
        check(code, 'core_decode');
        const length = trackedLength(outBuffer);
        if (length === 0) {
          return null;
        }
        // Copied out, because the buffer is freed below and a view over it would detach.
        return new Uint8Array(memory.buffer, outBuffer.data, length).slice();
      } finally {
        destroyBuffer(outBuffer);
      }
    } finally {
      destroyBuffer(toneBuffer);
    }
  }

  /**
   * Write samples into a buffer and record how many there are.
   *
   * Writing through a view does not by itself tell the core how much is there: the tracked length
   * is what the core reads, so a buffer filled through `samples()` and not through this is a
   * buffer the core believes is empty.
   */
  function fillSamples(buffer, input) {
    samples(buffer, input.length).set(input);
    check(e.core_buffer_set_len(buffer.ptr, input.length), 'core_buffer_set_len');
  }

  /** Write bytes into a buffer and record how many there are. */
  function fillBytes(buffer, bytes) {
    new Uint8Array(memory.buffer, buffer.data, bytes.length).set(bytes);
    check(e.core_buffer_set_len(buffer.ptr, bytes.length), 'core_buffer_set_len');
  }

  /** Copy a buffer's tracked bytes out as a fresh Uint8Array. */
  function readBytes(buffer) {
    const length = trackedLength(buffer);
    return new Uint8Array(memory.buffer, buffer.data, length).slice();
  }

  /**
   * Embed a frame into audio at keyed positions, returning a new Float32Array.
   *
   * `frame` is bytes. One bit per sample, so a frame of n bytes needs 8n samples; that is checked
   * here rather than left to the core so the message names the arithmetic.
   */
  function embedLsb(audio, frame, key) {
    if (!(audio instanceof Float32Array)) {
      throw new TypeError('embedLsb needs a Float32Array');
    }
    const needed = frame.length * 8;
    if (needed > audio.length) {
      throw new RangeError(
        `a ${frame.length} byte frame needs ${needed} samples, have ${audio.length}`,
      );
    }
    const audioBuffer = createBuffer(Math.max(1, audio.length));
    const frameBuffer = createBuffer(Math.max(1, frame.length));
    try {
      fillSamples(audioBuffer, audio);
      fillBytes(frameBuffer, frame);
      check(
        e.core_embed_lsb(audioBuffer.ptr, frameBuffer.ptr, key.lo, key.hi),
        'core_embed_lsb',
      );
      return readBuffer(audioBuffer);
    } finally {
      destroyBuffer(frameBuffer);
      destroyBuffer(audioBuffer);
    }
  }

  /**
   * Read `frameBytes` of frame out of audio at the same keyed positions.
   *
   * Returns the raw bytes whatever they are. Whether they are a mark is decided by the frame
   * decoder, not here, because the harness needs the raw bytes to count bit errors on a frame
   * that failed its checksum.
   */
  function extractLsb(audio, frameBytes, key) {
    if (!(audio instanceof Float32Array)) {
      throw new TypeError('extractLsb needs a Float32Array');
    }
    if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
      throw new TypeError(`frameBytes must be a positive integer, got ${frameBytes}`);
    }
    const audioBuffer = createBuffer(Math.max(1, audio.length));
    const outBuffer = createBuffer(frameBytes);
    try {
      fillSamples(audioBuffer, audio);
      check(
        e.core_extract_lsb(audioBuffer.ptr, frameBytes, key.lo, key.hi, outBuffer.ptr),
        'core_extract_lsb',
      );
      return readBytes(outBuffer);
    } finally {
      destroyBuffer(outBuffer);
      destroyBuffer(audioBuffer);
    }
  }

  /**
   * Samples one copy of a spread-spectrum mark needs for a frame of `frameBytes`, at `sampleRate`.
   * Ask before embedding: the core refuses audio shorter than this.
   */
  function ssMinSamples(frameBytes, sampleRate) {
    return e.core_ss_min_samples(frameBytes, sampleRate);
  }

  /**
   * Mark audio with the spread-spectrum scheme, returning a new Float32Array.
   *
   * `frame` is a whole frame (see `src/frame.js`). `strengthDb` is the mark's level relative to
   * the host in the carrier's band. Nothing here says whether that level is audible.
   *
   * `audio` is planar when `channels` is more than one: all of channel 0, then all of channel 1.
   * Every channel carries the same stream, which `docs/steganography.md` explains.
   */
  function ssEmbed(audio, frame, key, sampleRate, strengthDb, channels = 1) {
    if (!(audio instanceof Float32Array)) {
      throw new TypeError('ssEmbed needs a Float32Array');
    }
    if (!(frame instanceof Uint8Array)) {
      throw new TypeError('ssEmbed needs the frame as a Uint8Array');
    }
    const audioBuffer = createBuffer(Math.max(1, audio.length));
    const frameBuffer = createBuffer(Math.max(1, frame.length));
    try {
      fillSamples(audioBuffer, audio);
      fillBytes(frameBuffer, frame);
      check(
        e.core_ss_embed(audioBuffer.ptr, frameBuffer.ptr, key.lo, key.hi, sampleRate, strengthDb, channels),
        'core_ss_embed',
      );
      return readBuffer(audioBuffer);
    } finally {
      destroyBuffer(frameBuffer);
      destroyBuffer(audioBuffer);
    }
  }

  /**
   * Look for a spread-spectrum mark in audio at `sampleRate`.
   *
   * Returns `{ status, frame, confidence }`. `status` is `'verified'` only when the frame's
   * checksum matched, `'damaged'` when a header was found and the checksum did not, and
   * `'none'` when nothing was. `frame` is the bytes as read, and is not to be believed unless
   * the status is `'verified'`. `confidence` is the sync peak in standard deviations.
   *
   * `audio` is planar for more than one channel, and what is read is the average of the channels.
   */
  function ssDetect(audio, key, sampleRate, channels = 1) {
    if (!(audio instanceof Float32Array)) {
      throw new TypeError('ssDetect needs a Float32Array');
    }
    const audioBuffer = createBuffer(Math.max(1, audio.length));
    const outBuffer = createBuffer(SS_FRAME_CAPACITY);
    try {
      fillSamples(audioBuffer, audio);
      const code = e.core_ss_detect(
        audioBuffer.ptr, sampleRate, key.lo, key.hi, channels, outBuffer.ptr, scratch,
      );
      if (code < 0) check(code, 'core_ss_detect');
      const confidence = doubleOut(memory, scratch)[0];
      const status = code === 0 ? 'verified' : code === 2 ? 'damaged' : 'none';
      return { status, frame: readBytes(outBuffer), confidence };
    } finally {
      destroyBuffer(outBuffer);
      destroyBuffer(audioBuffer);
    }
  }

  /**
   * Apply one attack to a buffer, in place.
   *
   * `id` is one of the `ATTACKS` values in `src/attacks.js`, `param` means what that table says
   * it means, and `sampleRate` is passed rather than assumed because the filters and the resampler
   * are meaningless without the right one.
   */
  /**
   * Apply an attack to a plain Float32Array, returning a new one.
   *
   * The buffer is allocated with headroom, because some attacks make the signal longer: a time
   * shift adds silence and an upsampling resample nearly doubles it. Sizing it to the input
   * instead makes those two fail with a length error that names the buffer rather than the
   * attack.
   */
  function attack(id, param, sampleRate, audio, seed = 0) {
    if (!(audio instanceof Float32Array)) {
      throw new TypeError('attack needs a Float32Array');
    }
    const capacity = audio.length * 2 + ATTACK_HEADROOM;
    const buffer = createBuffer(Math.max(1, capacity));
    try {
      fillSamples(buffer, audio);
      check(e.core_attack(buffer.ptr, id, param, sampleRate, seed & 0xffffffff,
        Math.floor(seed / 0x100000000) >>> 0), 'core_attack');
      return readBuffer(buffer);
    } finally {
      destroyBuffer(buffer);
    }
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
    encodeBytes,
    decodeBytes,
    embedLsb,
    extractLsb,
    ssMinSamples,
    ssEmbed,
    ssDetect,
    attack,
    destroy,
  };
}