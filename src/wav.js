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

// ---------------------------------------------------------------------------------------------
// Several channels.
//
// `decodeWav` and `encodeWav` above are the mono 16-bit pair the tone codec uses, and they keep
// refusing anything else, because the tone codec is mono and a stereo file that was quietly
// folded to mono would be a different file. The pair below is for the watermark path, where real
// music is stereo, often 24-bit, and written by tools that put it behind WAVE_FORMAT_EXTENSIBLE.
// Channels stay separate here: folding is the caller's decision, never this module's.

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** Most channels accepted, matching the core's limit. */
export const MAX_CHANNELS = 8;

/**
 * A WAV file as one `Float32Array` per channel, or throws.
 *
 * Reads 8, 16, 24 and 32-bit integer PCM and 32-bit float, with `WAVE_FORMAT_EXTENSIBLE`, from one
 * to eight channels. Anything else is refused by name rather than half-read.
 *
 * @returns {{channelData: Float32Array[], sampleRate: number, channels: number,
 *            bitsPerSample: number, frames: number, floatSamples: boolean}}
 */
export function decodeWavChannels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) {
    throw new Error(`too short to be a WAV file: ${view.byteLength} bytes`);
  }
  if (view.getUint32(0, true) !== RIFF) throw new Error('not a RIFF file');
  if (view.getUint32(8, true) !== WAVE) throw new Error('RIFF file but not WAVE');

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data = null;

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
      if (format === FORMAT_EXTENSIBLE) {
        if (size < 40 || body + 26 > view.byteLength) {
          throw new Error('WAVE_FORMAT_EXTENSIBLE with a short fmt chunk');
        }
        // The real format is the first two bytes of the sub-format GUID.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === DATA) {
      // A declared size past the end of the file is clamped, as in `decodeWav`.
      data = { start: body, length: Math.min(size, view.byteLength - body) };
    }
    at = body + size + (size % 2);
  }

  if (!data) throw new Error('no data chunk');
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
    throw new Error(`only uncompressed PCM and float WAV are supported, format ${format}`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_CHANNELS) {
    throw new Error(`${channels} channels: this reads 1 to ${MAX_CHANNELS}`);
  }
  if (!(sampleRate > 0)) throw new Error(`sample rate ${sampleRate}`);
  const supported =
    format === FORMAT_FLOAT ? [32] : [8, 16, 24, 32];
  if (!supported.includes(bitsPerSample)) {
    throw new Error(`${bitsPerSample}-bit ${format === FORMAT_FLOAT ? 'float' : 'PCM'} is not supported`);
  }

  const width = bitsPerSample / 8;
  const frames = Math.floor(data.length / (width * channels));
  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
  const read =
    format === FORMAT_FLOAT
      ? (o) => view.getFloat32(o, true)
      : bitsPerSample === 16
        ? (o) => view.getInt16(o, true) / 32768
        : bitsPerSample === 24
          ? (o) => {
              // Sign-extended by shifting through the top of a 32-bit integer.
              const v = (view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16)) << 8 >> 8;
              return v / 8388608;
            }
          : bitsPerSample === 32
            ? (o) => view.getInt32(o, true) / 2147483648
            : (o) => (view.getUint8(o) - 128) / 128;
  let o = data.start;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      channelData[c][i] = read(o);
      o += width;
    }
  }
  return { channelData, sampleRate, channels, bitsPerSample, frames, floatSamples: format === FORMAT_FLOAT };
}

/**
 * Channels as an interleaved WAV, clipping rather than wrapping.
 *
 * `bits` is 16 or 24 for integer PCM, or 32 for 32-bit float. The default is 16, which is what an
 * MP3 or a browser-decoded file should become. A caller that has a file's own depth, from
 * `decodeWavChannels`, passes it, so that marking a 24-bit master does not quietly cut it to 16:
 * float input is written as float, and 8 or 32-bit integer input as 16 and 24 respectively would be
 * a guess, so those are asked for explicitly.
 *
 * 24-bit uses a plain `WAVE_FORMAT_PCM` header, which every reader this project has met accepts,
 * rather than the extensible form the spec asks for above 16 bits.
 */
export function encodeWavChannels(channelData, sampleRate, { bits = 16 } = {}) {
  const channels = channelData.length;
  if (channels < 1 || channels > MAX_CHANNELS) {
    throw new Error(`${channels} channels: this writes 1 to ${MAX_CHANNELS}`);
  }
  if (bits !== 16 && bits !== 24 && bits !== 32) {
    throw new Error(`${bits}-bit output: this writes 16, 24 or 32 (float)`);
  }
  const frames = channelData[0].length;
  if (channelData.some((c) => c.length !== frames)) {
    throw new Error('the channels are not the same length');
  }
  const width = bits / 8;
  const dataBytes = frames * channels * width;
  if (dataBytes > 0xffffffff - 36) throw new Error('too large for a WAV file');
  const buffer = new ArrayBuffer(44 + dataBytes);
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
  u32(36 + dataBytes);
  u32(WAVE);
  u32(FMT);
  u32(16);
  u16(bits === 32 ? FORMAT_FLOAT : FORMAT_PCM);
  u16(channels);
  u32(sampleRate);
  u32(sampleRate * channels * width);
  u16(channels * width);
  u16(bits);
  u32(DATA);
  u32(dataBytes);
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const v = channelData[c][i];
      if (bits === 32) {
        view.setFloat32(at, v, true);
      } else if (bits === 24) {
        const q = Math.round(Math.max(-1, Math.min(1, v)) * 8388607);
        view.setUint8(at, q & 0xff);
        view.setUint8(at + 1, (q >> 8) & 0xff);
        view.setUint8(at + 2, (q >> 16) & 0xff);
      } else {
        view.setInt16(at, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true);
      }
      at += width;
    }
  }
  return new Uint8Array(buffer);
}

/**
 * The output depth that keeps a file's own: 24 for 24-bit, 32 (float) for float, and 16 for everything
 * else, including formats that were never PCM in the first place.
 */
export function outputBitsFor(decoded) {
  if (decoded.floatSamples) return 32;
  return decoded.bitsPerSample === 24 ? 24 : 16;
}
