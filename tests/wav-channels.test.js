// tests/wav-channels.test.js
//
// The multi-channel WAV reader and writer. The mono pair is tested with the rest of `wav.js`; this
// is what stereo, 24-bit and extensible files go through, so the cases are the ones real files
// hit, built byte by byte rather than by the writer under test.

import { describe, expect, it } from 'vitest';
import { decodeWav, decodeWavChannels, encodeWavChannels, MAX_CHANNELS } from '../src/wav.js';

/** A WAV built by hand, so the reader is not tested against its own writer. */
function wav({ format = 1, channels = 2, rate = 44100, bits = 16, frames = [[0, 0]], extensible = false, extraChunk = false }) {
  const width = bits / 8;
  const fmtSize = extensible ? 40 : 16;
  const dataSize = frames.length * channels * width;
  const parts = [];
  const push = (...bytes) => parts.push(Buffer.from(bytes));
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); };
  const list = extraChunk ? 12 : 0;
  push(...Buffer.from('RIFF')); u32(4 + 8 + fmtSize + list + 8 + dataSize);
  push(...Buffer.from('WAVE'));
  push(...Buffer.from('fmt ')); u32(fmtSize);
  u16(extensible ? 0xfffe : format); u16(channels); u32(rate); u32(rate * channels * width); u16(channels * width); u16(bits);
  if (extensible) {
    u16(22); u16(bits); u32(0);
    u16(format); push(0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71);
  }
  if (extraChunk) { push(...Buffer.from('LIST')); u32(4); push(...Buffer.from('INFO')); }
  push(...Buffer.from('data')); u32(dataSize);
  for (const frame of frames) {
    for (const sample of frame) {
      const b = Buffer.alloc(width);
      if (format === 3) b.writeFloatLE(sample);
      else if (bits === 8) b.writeUInt8(sample + 128);
      else if (bits === 16) b.writeInt16LE(sample);
      else if (bits === 24) b.writeIntLE(sample, 0, 3);
      else b.writeInt32LE(sample);
      parts.push(b);
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}

describe('decodeWavChannels', () => {
  it('keeps the channels of a stereo file apart', () => {
    const out = decodeWavChannels(wav({ frames: [[16384, -16384], [8192, -8192], [0, 0]] }));
    expect(out.channels).toBe(2);
    expect(out.frames).toBe(3);
    expect(Array.from(out.channelData[0])).toEqual([0.5, 0.25, 0]);
    expect(Array.from(out.channelData[1])).toEqual([-0.5, -0.25, 0]);
  });

  it('reads mono, 24-bit, 32-bit integer, 8-bit and float', () => {
    expect(decodeWavChannels(wav({ channels: 1, frames: [[16384]] })).channelData[0][0]).toBe(0.5);
    expect(decodeWavChannels(wav({ bits: 24, frames: [[4194304, -4194304]] })).channelData.map((c) => c[0])).toEqual([0.5, -0.5]);
    expect(decodeWavChannels(wav({ bits: 32, channels: 1, frames: [[1073741824]] })).channelData[0][0]).toBe(0.5);
    expect(decodeWavChannels(wav({ bits: 8, channels: 1, frames: [[64], [-64]] })).channelData[0][0]).toBe(0.5);
    expect(decodeWavChannels(wav({ format: 3, bits: 32, frames: [[0.25, -0.75]] })).channelData.map((c) => c[0])).toEqual([0.25, -0.75]);
  });

  it('sign-extends 24-bit samples rather than reading a negative as a large positive', () => {
    const out = decodeWavChannels(wav({ bits: 24, channels: 1, frames: [[-1], [-8388608], [8388607]] }));
    expect(out.channelData[0][0]).toBeCloseTo(-1 / 8388608, 12);
    expect(out.channelData[0][1]).toBe(-1);
    expect(out.channelData[0][2]).toBeCloseTo(1, 6);
  });

  it('reads WAVE_FORMAT_EXTENSIBLE, which is what 24-bit and surround files use', () => {
    const out = decodeWavChannels(wav({ bits: 24, extensible: true, frames: [[4194304, 0]] }));
    expect(out.channels).toBe(2);
    expect(out.channelData[0][0]).toBe(0.5);
  });

  it('walks past chunks it does not know', () => {
    const out = decodeWavChannels(wav({ extraChunk: true, frames: [[16384, 0]] }));
    expect(out.channelData[0][0]).toBe(0.5);
  });

  it('ignores a trailing partial frame instead of misaligning the channels', () => {
    const bytes = wav({ frames: [[100, 200], [300, 400]] });
    const cut = bytes.slice(0, bytes.length - 2); // drops the last sample of the last frame
    expect(decodeWavChannels(cut).frames).toBe(1);
  });

  it('refuses what it cannot read, by name', () => {
    expect(() => decodeWavChannels(new Uint8Array(4))).toThrow(/too short/);
    expect(() => decodeWavChannels(new Uint8Array(20))).toThrow(/not a RIFF/);
    expect(() => decodeWavChannels(wav({ format: 2, bits: 16, frames: [[0, 0]] }))).toThrow(/format 2/);
    const twelve = wav({ frames: [[0, 0]] });
    new DataView(twelve.buffer).setUint16(34, 12, true); // bits per sample, in a 16-bit file's header
    expect(() => decodeWavChannels(twelve)).toThrow(/not supported/);
    expect(() => decodeWavChannels(wav({ channels: MAX_CHANNELS + 1, frames: [new Array(MAX_CHANNELS + 1).fill(0)] }))).toThrow(/channels/);
    expect(() => decodeWavChannels(wav({ channels: 0, frames: [] }))).toThrow(/channels/);
  });

  it('is not the mono reader, which still refuses stereo', () => {
    expect(() => decodeWav(wav({ frames: [[0, 0]] }))).toThrow(/only mono/);
  });
});

describe('encodeWavChannels', () => {
  it('round trips stereo through the reader to within a 16-bit step', () => {
    const left = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i / 7) * 0.8);
    const right = Float32Array.from({ length: 500 }, (_, i) => Math.cos(i / 11) * 0.6);
    const back = decodeWavChannels(encodeWavChannels([left, right], 48000));
    expect(back.sampleRate).toBe(48000);
    expect(back.channels).toBe(2);
    for (let i = 0; i < 500; i += 1) {
      expect(Math.abs(back.channelData[0][i] - left[i])).toBeLessThan(2 / 32768);
      expect(Math.abs(back.channelData[1][i] - right[i])).toBeLessThan(2 / 32768);
    }
  });

  it('clips rather than wraps', () => {
    const back = decodeWavChannels(encodeWavChannels([Float32Array.of(2, -2)], 8000));
    expect(back.channelData[0][0]).toBeGreaterThan(0.99);
    expect(back.channelData[0][1]).toBeLessThan(-0.99);
  });

  it('refuses channels of different lengths and too many channels', () => {
    expect(() => encodeWavChannels([new Float32Array(3), new Float32Array(4)], 8000)).toThrow(/same length/);
    expect(() => encodeWavChannels([], 8000)).toThrow(/channels/);
  });

  it('writes a header the mono reader accepts for one channel', () => {
    const out = decodeWav(encodeWavChannels([Float32Array.of(0.25, -0.25)], 22050));
    expect(out.sampleRate).toBe(22050);
    expect(out.samples.length).toBe(2);
  });
});
