// tests/mark.test.js
//
// The codec end to end, from a string to a waveform and back, across the JavaScript layer and
// the boundary.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCore } from '../src/load-node.js';
import { mark, read } from '../src/mark.js';
import { checksumByte, decodePayload, encodePayload, toAscii } from '../src/payload.js';
import { decodeWav, encodeWav, pcm16ToSamples, samplesToPcm16 } from '../src/wav.js';

const RATE = 22050;

let core;

beforeAll(async () => {
  core = await loadCore();
});

afterAll(() => {
  if (core) core.destroy();
});

describe('the payload layer', () => {
  it('prepends a checksum character', () => {
    const bytes = encodePayload('abc', { punycode: false });
    expect(bytes.length).toBe(4);
    expect(bytes[0]).toBe(checksumByte(new TextEncoder().encode('abc')));
    expect(new TextDecoder().decode(bytes.subarray(1))).toBe('abc');
  });

  it('round trips a payload', () => {
    const result = decodePayload(encodePayload('abc', { punycode: false }), { punycode: false });
    expect(result).toEqual({ ok: true, reason: 'ok', text: 'abc' });
  });

  it('refuses a payload the tone table cannot carry', () => {
    expect(() => encodePayload('x'.repeat(200), { punycode: false })).toThrow(RangeError);
    expect(() => encodePayload('x'.repeat(128), { punycode: false })).toThrow(RangeError);
  });

  it('refuses an empty payload', () => {
    expect(() => encodePayload('', { punycode: false })).toThrow(RangeError);
  });

  it('says no-mark rather than returning nothing', () => {
    expect(decodePayload(new Uint8Array(0))).toEqual({ ok: false, reason: 'no-mark', text: '' });
  });

  it('says too-short rather than returning nothing', () => {
    expect(decodePayload(new Uint8Array([65]))).toEqual({ ok: false, reason: 'too-short', text: '' });
  });

  it('refuses a payload whose checksum does not match', () => {
    // The reference logs "Checksum failed!" and returns the string anyway. This returns a
    // refusal, because a wrong payload reported as a right one is the failure that matters.
    const bytes = encodePayload('abc', { punycode: false });
    bytes[2] = bytes[2] ^ 0x01; // change one letter, leave the checksum
    const result = decodePayload(bytes, { punycode: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('checksum');
    expect(result.text).toBe('');
  });

  it('does not catch a transposition, which is a property of a byte sum', () => {
    // Recorded rather than fixed: the reference sums bytes, so order does not matter.
    const a = encodePayload('ab', { punycode: false });
    const b = encodePayload('ba', { punycode: false });
    expect(a[0]).toBe(b[0]);
  });

  it('punycodes a URL and leaves plain text alone', () => {
    expect(toAscii('http://example.com/')).toBe('http://example.com/');
    expect(toAscii('just some text')).toBe('just some text');
  });
});

describe('marking and reading', () => {
  it('recovers the text that was marked', () => {
    const result = read(core, mark(core, 'abc', { punycode: false }), { punycode: false });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('abc');
  });

  it('recovers a longer payload', () => {
    const text = 'http://danbri.org/foaf';
    const result = read(core, mark(core, text), {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain('danbri.org');
  });

  it('pads the tones with silence at each end', () => {
    const tones = mark(core, 'A', { punycode: false });
    expect(Array.from(tones.slice(0, 200))).toEqual(Array(200).fill(0));
    expect(Array.from(tones.slice(-200))).toEqual(Array(200).fill(0));
  });

  it('says no-mark for silence rather than guessing', () => {
    const result = read(core, new Float32Array(RATE), { punycode: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-mark');
  });

  it('refuses to encode an empty payload', () => {
    expect(() => core.encodeBytes(new Uint8Array(0))).toThrow(RangeError);
  });

  it('refuses a payload that is not a byte array', () => {
    expect(() => core.encodeBytes([1, 2, 3])).toThrow(TypeError);
    expect(() => core.decodeBytes('abc')).toThrow(TypeError);
  });

  it('survives being marked and read many times in a row', () => {
    for (let i = 0; i < 20; i += 1) {
      const result = read(core, mark(core, `run ${i}`, { punycode: false }), { punycode: false });
      expect(result.ok).toBe(true);
      expect(result.text).toBe(`run ${i}`);
    }
  });
});

describe('WAV', () => {
  it('round trips samples through a file', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]);
    const decoded = decodeWav(encodeWav(samples, RATE));
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.channels).toBe(1);
    expect(decoded.bitsPerSample).toBe(16);
    // 16-bit quantisation, so compare at that resolution.
    for (let i = 0; i < samples.length; i += 1) {
      expect(decoded.samples[i]).toBeCloseTo(samples[i], 4);
    }
  });

  it('clips rather than wrapping', () => {
    const pcm = samplesToPcm16(Float32Array.from([2, -2]));
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32767);
  });

  it('scales by 32767 and back', () => {
    expect(Array.from(samplesToPcm16(Float32Array.from([1])))).toEqual([32767]);
    expect(pcm16ToSamples(Int16Array.from([32767]))[0]).toBeCloseTo(1, 6);
  });

  it('refuses a file that is not a RIFF', () => {
    expect(() => decodeWav(new Uint8Array(100))).toThrow(/not a RIFF/);
  });

  it('refuses a file too short to be a WAV', () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow(/too short/);
  });

  it('skips a chunk it does not know rather than misreading the ones after it', () => {
    // An empty LIST chunk spliced in before fmt. A decoder assuming fixed offsets would read
    // fmt at the wrong place and get a plausible wrong sample rate.
    const wav = encodeWav(Float32Array.from([0.5, -0.5]), RATE);
    const withList = new Uint8Array(wav.byteLength + 8);
    withList.set(wav.subarray(0, 12));
    const view = new DataView(withList.buffer);
    view.setUint32(12, 0x5453494c, true); // "LIST"
    view.setUint32(16, 0, true); // zero-length, so the walk lands on fmt
    withList.set(wav.subarray(12), 20);

    const decoded = decodeWav(withList);
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.samples.length).toBe(2);
    expect(decoded.samples[0]).toBeCloseTo(0.5, 4);
    expect(decoded.samples[1]).toBeCloseTo(-0.5, 4);
  });

  it('carries a marked payload through a file', () => {
    const tones = mark(core, 'through a file', { punycode: false });
    const decoded = decodeWav(encodeWav(tones, RATE));
    expect(decoded.sampleRate).toBe(RATE);
    const result = read(core, decoded.samples, { punycode: false });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('through a file');
  });
});

describe('the tone rate', () => {
  it('is the one the Rust tone table uses', async () => {
    const { readFileSync } = await import('node:fs');
    const { TONE_RATE } = await import('../src/mark.js');
    const rust = readFileSync(new URL('../wasm/src/tables.rs', import.meta.url), 'utf8');
    const declared = rust.match(/pub const SAMPLE_RATE: u32 = ([\d_]+);/);
    expect(declared, 'tables.rs no longer declares SAMPLE_RATE this way').not.toBeNull();
    expect(Number(declared[1].replace(/_/g, ''))).toBe(TONE_RATE);
  });
});
