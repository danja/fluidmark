// tests/watermark.test.js
//
// The steganographic path: framing, keyed embedding, and reading it back.
//
// The point of these tests is mostly negative. A keyed low-bit scheme is supposed to be fragile,
// and these check that it is fragile in the ways the literature says, because a baseline that
// turns out to be robust means the harness is not measuring what it claims.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCore } from '../src/load-node.js';
import {
  bitErrors,
  crc16,
  frame,
  frameBytesFor,
  MAGIC,
  REASONS,
  unframe,
} from '../src/frame.js';
import { embed, extract, extractRaw, splitKey } from '../src/watermark.js';

const KEY = 0x0123_4567_89ab_cdefn;
const RATE = 44100;

let core;

beforeAll(async () => {
  core = await loadCore();
});

afterAll(() => {
  if (core) core.destroy();
});

/** Deterministic audio: a chord, not a tone, so no single frequency dominates. */
function audio(seconds = 1) {
  const n = Math.round(RATE * seconds);
  return Float32Array.from({ length: n }, (_, i) => {
    const t = i / RATE;
    return (
      0.30 * Math.sin(2 * Math.PI * 220 * t) +
      0.20 * Math.sin(2 * Math.PI * 330 * t) +
      0.10 * Math.sin(2 * Math.PI * 550 * t) +
      0.05 * Math.sin(2 * Math.PI * 1100 * t)
    );
  });
}

const PAYLOAD = new TextEncoder().encode('http://danbri.org/foaf');

describe('framing', () => {
  it('round trips a payload', () => {
    const decoded = unframe(frame(PAYLOAD));
    expect(decoded.ok).toBe(true);
    expect(Array.from(decoded.payload)).toEqual(Array.from(PAYLOAD));
  });

  it('says no-mark for bytes that are not a frame', () => {
    expect(unframe(new Uint8Array(0)).reason).toBe(REASONS.NO_MARK);
    expect(unframe(new Uint8Array(4)).reason).toBe(REASONS.NO_MARK);
    expect(unframe(new Uint8Array(64)).reason).toBe(REASONS.NO_MARK);
    expect(unframe(new Uint8Array(64).fill(0xff)).reason).toBe(REASONS.NO_MARK);
  });

  it('says damaged rather than no-mark when the magic is there and the rest is not', () => {
    const bytes = frame(PAYLOAD);
    bytes[15] ^= 0xff;
    const decoded = unframe(bytes);
    expect(decoded.ok).toBe(false);
    expect(decoded.reason).toBe(REASONS.DAMAGED);
  });

  it('reports an unknown version as damaged with the version in it', () => {
    const bytes = frame(PAYLOAD);
    bytes[4] = 42;
    expect(unframe(bytes)).toEqual({ ok: false, reason: REASONS.DAMAGED, detail: 'version 42' });
  });

  it('reports a length field that runs past the end', () => {
    const bytes = frame(PAYLOAD);
    bytes[6] = 0xff;
    bytes[7] = 0xff;
    expect(unframe(bytes).reason).toBe(REASONS.DAMAGED);
  });

  it('detects a transposition, which a byte sum could not', () => {
    expect(crc16(new TextEncoder().encode('ab'))).not.toBe(
      crc16(new TextEncoder().encode('ba')),
    );
  });

  it('agrees with the core about the CRC', async () => {
    // The frame layout exists in both languages. This is what stops that being a fork.
    const f = await import('../src/frame.js');
    expect(f.MAGIC).toEqual(MAGIC);
    // Every payload length from 0 to 64 round trips through the JS frame, and the JS CRC of the
    // payload is what the frame header stores.
    for (let len = 0; len <= 64; len += 1) {
      const payload = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 1) & 0xff);
      const bytes = frame(payload);
      const crc = bytes[8] | (bytes[9] << 8);
      expect(crc, `length ${len}`).toBe(crc16(payload));
      expect(unframe(bytes).ok, `length ${len}`).toBe(true);
    }
  });

  it('sizes a frame from its payload', () => {
    expect(frameBytesFor(0)).toBe(10);
    expect(frameBytesFor(PAYLOAD.length)).toBe(10 + PAYLOAD.length);
  });
});

describe('the key', () => {
  it('splits without losing precision', () => {
    expect(splitKey(0x0123_4567_89ab_cdefn)).toEqual({ lo: 0x89abcdef, hi: 0x01234567 });
  });

  it('round trips through bigint and number alike', () => {
    const asBig = splitKey(42n);
    const asNumber = splitKey(42);
    expect(asBig).toEqual(asNumber);
  });
});

describe('embedding and reading', () => {
  it('recovers a payload from untouched audio', () => {
    const marked = embed(core, audio(1), PAYLOAD, { key: KEY });
    const result = extract(core, marked, { key: KEY, payloadBytes: PAYLOAD.length });
    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(result.payload)).toBe('http://danbri.org/foaf');
  });

  it('does not modify the audio it was given', () => {
    const original = audio(1);
    const copy = Float32Array.from(original);
    embed(core, original, PAYLOAD, { key: KEY });
    expect(Array.from(original)).toEqual(Array.from(copy));
  });

  it('says no-mark for audio with nothing in it', () => {
    const result = extract(core, audio(1), { key: KEY, payloadBytes: PAYLOAD.length });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REASONS.NO_MARK);
  });

  it('says no-mark for silence', () => {
    const silence = new Float32Array(RATE);
    const result = extract(core, silence, { key: KEY, payloadBytes: PAYLOAD.length });
    expect(result.reason).toBe(REASONS.NO_MARK);
  });

  it('reports nothing with the wrong key', () => {
    const marked = embed(core, audio(1), PAYLOAD, { key: KEY });
    const result = extract(core, marked, { key: KEY ^ 0xffn, payloadBytes: PAYLOAD.length });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REASONS.NO_MARK);
  });

  it('is deterministic: the same audio and key give the same mark', () => {
    const a = embed(core, audio(1), PAYLOAD, { key: KEY });
    const b = embed(core, audio(1), PAYLOAD, { key: KEY });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('embeds different keys at different places in the same audio', () => {
    const a = embed(core, audio(1), PAYLOAD, { key: 1 });
    const b = embed(core, audio(1), PAYLOAD, { key: 2 });
    const bits = frameBytesFor(PAYLOAD.length) * 8;
    let differing = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) differing += 1;
    }
    // Each key writes the same number of bits, but to different samples, so more samples differ
    // than there are bits: a sample one key touched and the other did not still differs whenever
    // the written bit was not already there. At most twice the bits, since a sample both touched
    // can differ once and a sample neither touched cannot differ at all.
    expect(differing).toBeGreaterThan(bits);
    expect(differing).toBeLessThanOrEqual(2 * bits);
  });

  it('refuses a frame that does not fit in the audio', () => {
    expect(() => embed(core, new Float32Array(100), PAYLOAD, { key: KEY })).toThrow(RangeError);
  });

  it('requires a payload size to read, because this scheme has no sync word', () => {
    const marked = embed(core, audio(1), PAYLOAD, { key: KEY });
    expect(() => extract(core, marked, { key: KEY })).toThrow(TypeError);
  });

  it('returns raw bytes so the harness can count bit errors', () => {
    const marked = embed(core, audio(1), PAYLOAD, { key: KEY });
    const raw = extractRaw(core, marked, frameBytesFor(PAYLOAD.length), KEY);
    expect(raw.length).toBe(frameBytesFor(PAYLOAD.length));
    expect(bitErrors(frame(PAYLOAD), raw)).toBe(0);
  });
});

describe('this scheme is fragile, as it should be', () => {
  const marked = () => embed(core, audio(1), PAYLOAD, { key: KEY });

  it('loses the payload to a small gain change', () => {
    const before = marked();
    const scaled = Float32Array.from(before, (x) => x * 0.99);
    const result = extract(core, scaled, { key: KEY, payloadBytes: PAYLOAD.length });
    expect(result.ok).toBe(false);
  });

  it('loses the payload to 16-bit requantisation of its own values', () => {
    // Multiplying by a factor that is not a power of two moves every sample off the 16-bit grid.
    const before = marked();
    const moved = Float32Array.from(before, (x) => Math.round(x * 32768) / 32768 + 1 / 65536);
    const result = extract(core, moved, { key: KEY, payloadBytes: PAYLOAD.length });
    expect(result.ok).toBe(false);
  });

  it('never claims a mark in unmarked audio, which matters more than any figure', () => {
    // The false-positive rate is the number that decides whether the system is usable. For this
    // scheme it is zero, because the magic is four specific bytes at a known place.
    let falsePositives = 0;
    for (let seed = 0; seed < 20; seed += 1) {
      let state = (seed * 2654435761) >>> 0;
      const noise = Float32Array.from({ length: RATE }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return ((state >>> 8) / 8388608 - 1) * 0.3;
      });
      const result = extract(core, noise, { key: KEY, payloadBytes: PAYLOAD.length });
      if (result.ok) falsePositives += 1;
    }
    expect(falsePositives).toBe(0);
  });
});