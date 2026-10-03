// src/mark.js
//
// The whole thing from a string to a waveform and back, which is what a host actually calls.
//
// Two thin layers over the core: the payload text handling from `payload.js`, and the core's
// encode and decode. A host that wants the payload as bytes rather than a string can go one
// level down and use the core directly.

import { decodePayload, encodePayload } from './payload.js';

/**
 * The rate the tone codec works at, in Hz. Tones are written and read at this rate and no other:
 * a file at another rate plays the tones at the wrong pitch and reads as no mark. Declared once
 * here, and `tests/mark.test.js` holds it equal to `SAMPLE_RATE` in `wasm/src/tables.rs`.
 */
export const TONE_RATE = 22050;

/**
 * A string to tones, ready to be mixed into or written as audio.
 *
 * @param core  from `createCore`
 * @param text  the payload
 * @param opts  `punycode` defaults to true, matching the reference
 * @returns {Float32Array} the tones, with silence padding at each end
 */
export function mark(core, text, opts = {}) {
  return core.encodeBytes(encodePayload(text, opts));
}

/**
 * Tones to a payload.
 *
 * Three outcomes, kept distinct because a caller has to be able to tell them apart: a payload
 * with a matching checksum, nothing found, or something found that does not check out. The
 * reference collapses the last two into an empty string and logs.
 *
 * @returns {{ok: boolean, reason: string, text: string}}
 */
export function read(core, tones, opts = {}) {
  const bytes = core.decodeBytes(tones);
  if (bytes === null) {
    return { ok: false, reason: 'no-mark', text: '' };
  }
  return decodePayload(bytes, opts);
}