// src/mp3.js
//
// Finding the frames in an MP3 file, so a decoder can be handed one at a time.
//
// Side-agnostic and pure: bytes in, frame ranges out. The decoding itself is the browser's
// (`src/audio-file.js` hands each frame to WebCodecs), which is why this is split off: the parsing
// is where the bugs were, and it can be tested in Node against real files.
//
// MPEG-1, MPEG-2 and MPEG-2.5, Layer III. The tone service that made the files people still hold
// wrote MPEG-2 at 22.05 kHz mono, so MPEG-1 alone, which is what an earlier version of this page
// parsed, rejected the files the page exists to read.

// Index 0 is "free format" and 15 is invalid; both are refused.
const BITRATES_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const SAMPLE_RATES = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
};

/** Most frames walked, so a hostile or enormous file cannot hold the page for ever. */
export const MAX_FRAMES = 400000;

/**
 * The Layer III header at `at`, or null if there is not one.
 *
 * @returns {{version: string, sampleRate: number, channels: number, bitrate: number,
 *            samplesPerFrame: number, length: number, sideInfoEnd: number} | null}
 */
export function readHeader(bytes, at) {
  if (at + 4 > bytes.length) return null;
  const b1 = bytes[at + 1];
  const b2 = bytes[at + 2];
  const b3 = bytes[at + 3];
  if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 0x03; // 0 is MPEG-2.5, 1 is reserved, 2 is MPEG-2, 3 is MPEG-1
  const layerBits = (b1 >> 1) & 0x03; // 1 is Layer III
  if (versionBits === 1 || layerBits !== 1) return null;
  const version = versionBits === 3 ? 'mpeg1' : versionBits === 2 ? 'mpeg2' : 'mpeg25';

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  const bitrate = BITRATES_KBPS[version === 'mpeg1' ? 'mpeg1' : 'mpeg2'][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  if (!bitrate || !sampleRate) return null;

  const padding = (b2 >> 1) & 0x01;
  const mono = ((b3 >> 6) & 0x03) === 3;
  const mpeg1 = version === 'mpeg1';
  return {
    version,
    sampleRate,
    channels: mono ? 1 : 2,
    bitrate,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    length: Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding,
    // Where a Xing or Info tag would start, after the header and the side information.
    sideInfoEnd: 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17),
  };
}

/** Whether a frame is the encoder's Xing or Info tag, which carries no audio. */
function isInfoFrame(bytes, start, header) {
  const at = start + header.sideInfoEnd;
  const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  return tag === 'Xing' || tag === 'Info';
}

/**
 * Every audio frame in a file, with the stream's format.
 *
 * Skips an ID3v2 tag at the front and any Xing or Info frame, and re-synchronises past bytes that
 * look like a header and are not: a frame is only accepted if the next one starts where it ends,
 * or it ends the file. Without that check, a stray 0xFF in tag data starts a run of garbage
 * frames. A file with no frames returns `frames: []`, which the caller must say, not decode.
 *
 * @returns {{frames: {start: number, end: number}[], sampleRate: number, channels: number,
 *            samplesPerFrame: number}}
 */
export function splitFrames(bytes) {
  let at = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // "ID3", version, flags, then a 28-bit size in four 7-bit bytes.
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    at = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
  }

  const frames = [];
  let format = null;
  while (at + 4 <= bytes.length && frames.length < MAX_FRAMES) {
    const header = readHeader(bytes, at);
    if (!header) {
      at += 1;
      continue;
    }
    const end = at + header.length;
    const endsFile = end >= bytes.length - 128; // a trailing ID3v1 tag is 128 bytes
    const nextOk = readHeader(bytes, end) !== null;
    if (!(nextOk || endsFile) || end > bytes.length + 1) {
      at += 1;
      continue;
    }
    if (format === null) {
      format = { sampleRate: header.sampleRate, channels: header.channels, samplesPerFrame: header.samplesPerFrame };
    }
    // Frames in one stream share a format; one that does not is a different stream spliced in.
    if (header.sampleRate === format.sampleRate && header.channels === format.channels) {
      if (!isInfoFrame(bytes, at, header)) {
        frames.push({ start: at, end: Math.min(end, bytes.length) });
      }
    }
    at = end;
  }
  return { frames, ...(format ?? { sampleRate: 0, channels: 0, samplesPerFrame: 0 }) };
}
