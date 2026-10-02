// src/wav.js
//
// Reading and writing 16-bit PCM WAV, in the shape the reference produces: mono, 22050 Hz.
//
// Written here rather than in Rust because it is byte-level file plumbing rather than DSP, and
// because a host that can write a WAV needs to agree with what `core_encoded_size` says about
// the audio, which is easier to check in one language.
//
// Only what the reference does is supported: mono, 16-bit PCM. A stereo or 24-bit file is
// refused rather than half-read, because decoding half a file produces a plausible wrong answer
// rather than an error.

const RIFF = 0x46464952; // "RIFF" little-endian
const WAVE = 0x45564157; // "WAVE"
const FMT = 0x20746d66; // "fmt "
const DATA = 0x61746164; // "data"

/** Samples to 16-bit little-endian PCM, clipping rather than wrapping. */
export function samplesToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/** 16-bit little-endian PCM to samples in -1..1. */
export function pcm16ToSamples(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = pcm[i] / 32767;
  }
  return out;
}

/** A mono 16-bit PCM WAV file as bytes. */
export function encodeWav(samples, sampleRate) {
  const pcm = samplesToPcm16(samples);
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  let at = 0;
  const u32 = (value) => {
    view.setUint32(at, value, true);
    at += 4;
  };
  const u16 = (value) => {
    view.setUint16(at, value, true);
    at += 2;
  };

  u32(RIFF);
  u32(36 + pcm.byteLength);
  u32(WAVE);
  u32(FMT);
  u32(16); // fmt chunk size
  u16(1); // PCM
  u16(1); // channels
  u32(sampleRate);
  u32(sampleRate * 2); // byte rate: rate * channels * bytes per sample
  u16(2); // block align
  u16(16); // bits per sample
  u32(DATA);
  u32(pcm.byteLength);
  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

/**
 * A mono 16-bit PCM WAV file as samples, or throws.
 *
 * Walks the chunk list rather than assuming the layout, because real files carry `LIST` and
 * `fact` chunks and a decoder that assumes offsets silently misreads them.
 */
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) {
    throw new Error(`too short to be a WAV file: ${view.byteLength} bytes`);
  }
  if (view.getUint32(0, true) !== RIFF) {
    throw new Error('not a RIFF file');
  }
  if (view.getUint32(8, true) !== WAVE) {
    throw new Error('RIFF file but not WAVE');
  }

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm = null;
  let format = 0;

  let at = 12;
  while (at + 8 <= view.byteLength) {
    const id = view.getUint32(at, true);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === FMT && body + 16 <= view.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === DATA) {
      // A data chunk whose declared size runs past the end is clamped rather than refused:
      // some encoders write a size larger than what they wrote.
      const available = Math.min(size, view.byteLength - body);
      pcm = new Int16Array(available >> 1);
      for (let i = 0; i < pcm.length; i += 1) {
        pcm[i] = view.getInt16(body + i * 2, true);
      }
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }

  if (format !== 1) {
    throw new Error(`only uncompressed PCM is supported, format ${format}`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`only 16-bit samples are supported, got ${bitsPerSample}`);
  }
  if (channels !== 1) {
    throw new Error(`only mono is supported, got ${channels} channels`);
  }
  if (!pcm) {
    throw new Error('no data chunk');
  }
  return { samples: pcm16ToSamples(pcm), sampleRate, channels, bitsPerSample };
}