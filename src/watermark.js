// src/watermark.js
//
// The steganographic path: a payload into audio and back, invisibly.
//
// Separate from `mark.js`, which is the audible tone codec from Delivery 1. Two schemes in one
// repository, and conflating them would make the harness numbers ambiguous: a figure has to say
// which scheme produced it.

import { frame, frameBytesFor, unframe } from './frame.js';

/** Split a key into the two 32-bit halves the ABI takes.
 *
 * A `u64` crosses the boundary as two `u32`s because a JS number cannot hold a 64-bit integer
 * exactly, and a key that arrives rounded is a key that does not reproduce.
 */
export function splitKey(key) {
  const n = typeof key === 'bigint' ? key : BigInt(Math.trunc(Number(key)));
  return {
    lo: Number(n & 0xffffffffn) >>> 0,
    hi: Number((n >> 32n) & 0xffffffffn) >>> 0,
  };
}

/**
 * Put a payload into audio, inaudibly.
 *
 * Returns a new Float32Array; the input is not modified.
 */
export function embed(core, audio, payload, { key = 0, flags = 0 } = {}) {
  const bytes = frame(payload, flags);
  const { lo, hi } = splitKey(key);
  return core.embedLsb(audio, bytes, { lo, hi });
}

/**
 * Read a payload out of audio.
 *
 * Reads exactly as many bytes as the frame would be for a payload of `payloadBytes`, which the
 * caller has to say: least-significant-bit embedding has no sync word to measure itself against,
 * so a reader cannot find where the frame starts. That is the scheme's first real limitation and
 * it is why the spread-spectrum work exists.
 *
 * Three outcomes, kept apart: a payload, no mark, or a mark that does not check out.
 */
export function extract(core, audio, { key = 0, payloadBytes } = {}) {
  if (typeof payloadBytes !== 'number' || payloadBytes < 0) {
    throw new TypeError('payloadBytes is required: this scheme has no sync word to find the length');
  }
  const { lo, hi } = splitKey(key);
  const bytes = core.extractLsb(audio, frameBytesFor(payloadBytes), { lo, hi });
  return unframe(bytes);
}

/**
 * Read the frame bytes out without interpreting them.
 *
 * The harness needs these to measure bit errors against the frame that went in, including on a
 * frame that failed its checksum. A read that only returned payloads would throw those away.
 */
export function extractRaw(core, audio, frameBytes, key = 0) {
  const { lo, hi } = splitKey(key);
  return core.extractLsb(audio, frameBytes, { lo, hi });
}