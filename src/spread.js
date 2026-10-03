// src/spread.js
//
// The spread-spectrum path: a payload into audio and back, with no help from the caller about
// where it starts or how long it is.
//
// Separate from `watermark.js`, which is the LSB control, and from `mark.js`, the audible tones.
// Three schemes in one repository, and a figure has to say which produced it.
//
// Audio is one `Float32Array` per channel, or a single `Float32Array` for mono. The policy for
// several channels lives in the core, not here: every channel carries the same stream, and a read
// uses the average of the channels. This file only lays the channels out the way the core wants.

import { frame, unframe } from './frame.js';
import { splitKey } from './watermark.js';

/**
 * The most frames per channel the core will mark in one call, matching `MAX_EMBED_FRAMES` in
 * `wasm/src/spread.rs`, which `tests/spread.test.js` holds equal. A longer file is refused with a
 * message before it is handed to the core, rather than as a code from inside it.
 */
export const MAX_EMBED_FRAMES = 1 << 25;

/** The level of the mark relative to the host in its band, in dB. See `docs/steganography.md`. */
export const DEFAULT_STRENGTH_DB = -20;

/**
 * How far under the model's masking threshold the mark sits, in dB, when `level` is `'masked'`. Not yet
 * chosen by anyone listening: see `docs/steganography.md` and `HUMANS.md`.
 */
export const DEFAULT_MASKED_MARGIN_DB = -6;

/**
 * The key used when none is given. It is public, in this source file, so a mark made with it is
 * one anyone can find and read. That is the right default for a mark meant to be read, and the
 * wrong one for anything else: give a key.
 */
export const DEFAULT_KEY = 0x0123_4567_89ab_cdefn;

/**
 * A 64-bit key from text, by FNV-1a over its UTF-8 bytes.
 *
 * Not a password hash, and not meant to be: it turns a phrase into the 64 bits the keyed sequence
 * wants, so the same phrase gives the same key on every host. A phrase that can be guessed gives a
 * key that can be guessed. Empty text gives the public default key, so "no key" is never a
 * different thing from "the default one".
 */
export function keyFromText(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  if (bytes.length === 0) return DEFAULT_KEY;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

/** Check what was passed is one array or one array per channel, and say how long. */
function shape(audio) {
  if (audio instanceof Float32Array) return { channels: 1, frames: audio.length };
  if (!Array.isArray(audio) || audio.length === 0 || !audio.every((c) => c instanceof Float32Array)) {
    throw new TypeError('audio is a Float32Array, or an array of one Float32Array per channel');
  }
  const frames = audio[0].length;
  if (audio.some((c) => c.length !== frames)) {
    throw new RangeError('the channels are not the same length');
  }
  return { channels: audio.length, frames };
}

function detectCore(core, audio, key, sampleRate) {
  shape(audio);
  return Array.isArray(audio)
    ? core.ssDetectChannels(audio, splitKey(key), sampleRate)
    : core.ssDetect(audio, splitKey(key), sampleRate, 1);
}

/**
 * Samples **per channel** one copy of the mark needs for `payloadBytes` of payload, at
 * `sampleRate`.
 *
 * A track shorter than this cannot carry the mark, and `embed` refuses it. A track several times
 * longer carries several copies, which is where the robustness comes from.
 */
export function minSamples(core, payloadBytes, sampleRate) {
  return core.ssMinSamples(10 + payloadBytes, sampleRate);
}

/**
 * Put a payload into audio. The input is not modified.
 *
 * `level` is `'relative'` (the default), where `strengthDb` is the mark's level relative to the music's in
 * the carrier's band, or `'masked'`, where it is how far under the masking threshold of a simplified
 * psychoacoustic model the mark sits, in every band and every frame. Returns the same shape it was
 * given: a `Float32Array` for a `Float32Array`, an array of them for an array. Throws `RangeError` for audio too short to hold one copy, naming how much it needs.
 */
export function embed(core, audio, payload, { key = DEFAULT_KEY, sampleRate, flags = 0, strengthDb, level = 'relative' } = {}) {
  if (level !== 'relative' && level !== 'masked') {
    throw new TypeError(`level is 'relative' or 'masked', got ${level}`);
  }
  const mode = level === 'masked' ? 1 : 0;
  // The default depends on what the number means: dB relative to the music's level in the band, or dB
  // under the masking threshold. They are different units, and a default for one is not a default for
  // the other.
  strengthDb ??= level === 'masked' ? DEFAULT_MASKED_MARGIN_DB : DEFAULT_STRENGTH_DB;
  if (!Number.isFinite(sampleRate)) {
    throw new TypeError('sampleRate is required: the mark is defined at 44.1 kHz and the core resamples to it');
  }
  const bytes = frame(payload, flags);
  const { frames } = shape(audio);
  if (frames > MAX_EMBED_FRAMES) {
    throw new RangeError(
      `${frames} samples per channel is more than one call will mark (${MAX_EMBED_FRAMES}, about ` +
        `${Math.floor(MAX_EMBED_FRAMES / sampleRate / 60)} minutes at ${sampleRate} Hz): split the track`,
    );
  }
  const needed = core.ssMinSamples(bytes.length, sampleRate);
  if (frames < needed) {
    throw new RangeError(
      `a ${payload.length} byte payload needs ${needed} samples per channel at ${sampleRate} Hz, have ${frames}`,
    );
  }
  // One array per channel goes to the core without a planar copy in between, which is a copy of the
  // whole track saved at the largest point. A single array is already one channel.
  if (Array.isArray(audio)) {
    return core.ssEmbedChannels(audio, bytes, splitKey(key), sampleRate, strengthDb, mode);
  }
  return core.ssEmbed(audio, bytes, splitKey(key), sampleRate, strengthDb, 1, mode);
}

/**
 * The core's answer as it comes, without interpreting the frame.
 *
 * `{ status: 'verified' | 'damaged' | 'none', frame, confidence }`. The attack harness needs the
 * frame bytes of a read that failed its checksum, to count how many bits survived, and `detect`
 * deliberately does not hand those out for a read that succeeded. Nothing but a tool measuring the
 * scheme has a reason to call this; a caller that wants an identifier wants `detect`.
 */
export function detectRaw(core, audio, { key = DEFAULT_KEY, sampleRate } = {}) {
  if (!Number.isFinite(sampleRate)) throw new TypeError('sampleRate is required');
  return detectCore(core, audio, key, sampleRate);
}

/**
 * Look for a mark.
 *
 * Three outcomes, kept apart so that "nothing here" cannot be read as "an empty payload":
 *
 * - `{ ok: true, payload, confidence, speed }`: found, and the checksum matched.
 * - `{ ok: false, reason: 'damaged', frame }`: a header was found, the checksum was not right. A mark
 *   was probably here. Nothing in `frame` is to be believed.
 * - `{ ok: false, reason: 'none' }`: nothing found.
 *
 * `confidence` is the sync peak in standard deviations, a measure of how clearly the start of the
 * mark stood out, and not a probability. `speed` is how much longer the file was than the mark's own
 * timing, as a ratio: 1 normally, 1.0001 for a file slowed by 0.01%, which the reader corrects for.
 */
export function detect(core, audio, { key = DEFAULT_KEY, sampleRate } = {}) {
  if (!Number.isFinite(sampleRate)) {
    throw new TypeError('sampleRate is required');
  }
  const found = detectCore(core, audio, key, sampleRate);
  if (found.status === 'none') return { ok: false, reason: 'none', confidence: found.confidence, speed: found.speed };
  if (found.status === 'damaged') {
    return { ok: false, reason: 'damaged', frame: found.frame, confidence: found.confidence, speed: found.speed };
  }
  // The core already checked, but the frame is checked again here, so that a core and a wrapper
  // that disagree about the format fail loudly rather than quietly.
  const decoded = unframe(found.frame);
  if (!decoded.ok) {
    throw new Error(`core reported a verified frame that the wrapper rejects: ${decoded.reason}`);
  }
  return { ok: true, payload: decoded.payload, confidence: found.confidence, speed: found.speed };
}
