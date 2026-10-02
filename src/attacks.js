// src/attacks.js
//
// The attack list, as data.
//
// Kept out of `bin/attack.js` so the specification of what a watermark has to survive is one
// table rather than being spread across the code that runs it. Every row is in the brief:
// significant processing and degradation in the time and frequency domains.

/** Ids, matching the `ATTACK_*` constants in `wasm/src/lib.rs`. */
export const ATTACKS = {
  GAIN_DB: 1,
  DITHER: 2,
  WHITE_NOISE: 3,
  PINK_NOISE: 4,
  LOWPASS: 5,
  HIGHPASS: 6,
  RESAMPLE: 7,
  TIME_SHIFT: 8,
  CROP_FRACTION: 9,
};

/**
 * The list. `param` means something different per row, as `core_attack` documents.
 *
 * `external` marks the ones that need a tool this project does not have, so they can be reported
 * as skipped rather than quietly absent. There are none in this table: the lossy rows are added
 * by the caller because they need ffmpeg and a decision about whether it is there.
 */
export const ATTACK_LIST = [
  { id: ATTACKS.GAIN_DB, name: 'gain -6 dB', param: -6 },
  { id: ATTACKS.GAIN_DB, name: 'gain -0.5 dB', param: -0.5 },
  { id: ATTACKS.GAIN_DB, name: 'gain +3 dB', param: 3 },
  { id: ATTACKS.DITHER, name: 'dither 48 dB SNR', param: 48, seed: 1 },
  { id: ATTACKS.DITHER, name: 'dither 36 dB SNR', param: 36, seed: 2 },
  { id: ATTACKS.WHITE_NOISE, name: 'white noise 30 dB SNR', param: 30, seed: 3 },
  { id: ATTACKS.WHITE_NOISE, name: 'white noise 20 dB SNR', param: 20, seed: 4 },
  { id: ATTACKS.PINK_NOISE, name: 'pink noise 30 dB SNR', param: 30, seed: 5 },
  { id: ATTACKS.PINK_NOISE, name: 'pink noise 20 dB SNR', param: 20, seed: 6 },
  { id: ATTACKS.LOWPASS, name: 'low-pass 5 kHz', param: 5000 },
  { id: ATTACKS.LOWPASS, name: 'low-pass 1 kHz', param: 1000 },
  { id: ATTACKS.HIGHPASS, name: 'high-pass 200 Hz', param: 200 },
  { id: ATTACKS.HIGHPASS, name: 'high-pass 2 kHz', param: 2000 },
  { id: ATTACKS.RESAMPLE, name: 'resample to 48 kHz', param: 48000 / 44100 },
  { id: ATTACKS.RESAMPLE, name: 'resample to 22.05 kHz', param: 22050 / 44100 },
  { id: ATTACKS.TIME_SHIFT, name: 'time shift 1000 samples', param: 1000 },
  { id: ATTACKS.CROP_FRACTION, name: 'crop first 5%', param: 0.05 },
];