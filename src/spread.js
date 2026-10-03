// src/spread.js
//
// The spread-spectrum path: a payload into audio and back, with no help from the caller about
// where it starts or how long it is.
//
// Separate from `watermark.js`, which is the LSB control, and from `mark.js`, the audible tones.
// Three schemes in one repository, and a figure has to say which produced it.

import { frame, unframe } from './frame.js';
import { splitKey } from './watermark.js';

/** The level of the mark relative to the host in its band, in dB. See `docs/steganography.md`. */
export const DEFAULT_STRENGTH_DB = -20;

/**
 * Samples one copy of the mark needs for `payloadBytes` of payload, at `sampleRate`.
 *
 * A track shorter than this cannot carry the mark, and `embed` refuses it. A track several times
 * longer carries several copies, which is where the robustness comes from.
 */
export function minSamples(core, payloadBytes, sampleRate) {
  return core.ssMinSamples(10 + payloadBytes, sampleRate);
}

/**
 * Put a payload into audio. Returns a new Float32Array; the input is not modified.
 *
 * Throws `RangeError` for audio too short to hold one copy, naming how much it needs.
 */
export function embed(core, audio, payload, { key = 0, sampleRate, flags = 0, strengthDb = DEFAULT_STRENGTH_DB } = {}) {
  if (!Number.isFinite(sampleRate)) {
    throw new TypeError('sampleRate is required: the mark is defined at 44.1 kHz and the core resamples to it');
  }
  const bytes = frame(payload, flags);
  const needed = core.ssMinSamples(bytes.length, sampleRate);
  if (audio.length < needed) {
    throw new RangeError(
      `a ${payload.length} byte payload needs ${needed} samples at ${sampleRate} Hz, have ${audio.length}`,
    );
  }
  return core.ssEmbed(audio, bytes, splitKey(key), sampleRate, strengthDb);
}

/**
 * Look for a mark.
 *
 * Three outcomes, kept apart so that "nothing here" cannot be read as "an empty payload":
 *
 * - `{ ok: true, payload, confidence }`: found, and the checksum matched.
 * - `{ ok: false, reason: 'damaged', frame }`: a header was found, the checksum was not right. A mark
 *   was probably here. Nothing in `frame` is to be believed.
 * - `{ ok: false, reason: 'none' }`: nothing found.
 *
 * `confidence` is the sync peak in standard deviations, a measure of how clearly the start of the
 * mark stood out, and not a probability.
 */
export function detect(core, audio, { key = 0, sampleRate } = {}) {
  if (!Number.isFinite(sampleRate)) {
    throw new TypeError('sampleRate is required');
  }
  const found = core.ssDetect(audio, splitKey(key), sampleRate);
  if (found.status === 'none') return { ok: false, reason: 'none', confidence: found.confidence };
  if (found.status === 'damaged') {
    return { ok: false, reason: 'damaged', frame: found.frame, confidence: found.confidence };
  }
  // The core already checked, but the frame is checked again here, so that a core and a wrapper
  // that disagree about the format fail loudly rather than quietly.
  const decoded = unframe(found.frame);
  if (!decoded.ok) {
    throw new Error(`core reported a verified frame that the wrapper rejects: ${decoded.reason}`);
  }
  return { ok: true, payload: decoded.payload, confidence: found.confidence };
}
