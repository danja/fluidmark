// tests/spread.test.js
//
// The spread-spectrum path through the JavaScript wrapper and the Wasm boundary.
//
// The scheme itself is tested in `wasm/src/spread.rs`. What is tested here is what only the
// wrapper can get wrong: the three outcomes staying apart across the boundary, the refusal of
// audio too short to carry a mark, and a real attack list run through real attack code. The host
// is `synthTrack`, which is not music; the harness on a real recording is the measurement.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCore } from '../src/load-node.js';
import { ATTACKS } from '../src/attacks.js';
import { frame } from '../src/frame.js';
import { splitKey } from '../src/watermark.js';
import { detect, embed, minSamples } from '../src/spread.js';
import { synthTrack } from '../src/synth.js';

// Embedding and reading a half-minute of audio takes a second or two each, and the suite runs
// files in parallel. The default five seconds is a limit on a quick unit test, not on this.
vi.setConfig({ testTimeout: 60000 });

const KEY = 0x0123_4567_89ab_cdefn;
const RATE = 44100;
const PAYLOAD = new TextEncoder().encode('urn:x:track-1');

let core;
let host;
let marked;

beforeAll(async () => {
  core = await loadCore();
  // Two copies' worth, so there is something to combine.
  host = synthTrack((minSamples(core, PAYLOAD.length, RATE) / RATE) * 2.2, RATE, 5);
  marked = embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE });
}, 60000);

afterAll(() => {
  if (core) core.destroy();
});

const read = (audio, rate = RATE, key = KEY) => detect(core, audio, { key, sampleRate: rate });

describe('embedding', () => {
  it('returns a new array and leaves the input alone', () => {
    const before = Float32Array.from(host);
    embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE });
    expect(Array.from(host)).toEqual(Array.from(before));
    expect(marked).not.toBe(host);
    expect(marked.length).toBe(host.length);
    expect(Array.from(marked)).not.toEqual(Array.from(host));
  });

  it('is deterministic: the same audio and key give the same mark', () => {
    const again = embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE });
    expect(Array.from(again)).toEqual(Array.from(marked));
  });

  it('refuses audio too short for one copy, and says how much it needs', () => {
    const short = host.slice(0, RATE * 3);
    expect(() => embed(core, short, PAYLOAD, { key: KEY, sampleRate: RATE })).toThrow(/needs \d+ samples/);
  });

  it('needs the sample rate, because the mark is defined at one rate', () => {
    expect(() => embed(core, host, PAYLOAD, { key: KEY })).toThrow(TypeError);
    expect(() => detect(core, host, { key: KEY })).toThrow(TypeError);
  });

  it('refuses a rate it cannot work at', () => {
    expect(() => embed(core, host, PAYLOAD, { key: KEY, sampleRate: 100 })).toThrow();
  });
});

describe('reading', () => {
  it('recovers the payload and says it was verified', () => {
    const found = read(marked);
    expect(found.ok).toBe(true);
    expect(new TextDecoder().decode(found.payload)).toBe('urn:x:track-1');
    expect(found.confidence).toBeGreaterThan(5);
  });

  it('reports nothing for an unmarked track, as nothing and not as a damaged mark', () => {
    for (const seed of [1, 2, 3]) {
      const found = read(synthTrack(host.length / RATE, RATE, seed));
      expect(found.ok).toBe(false);
      expect(found.reason).toBe('none');
    }
  });

  it('reports nothing for the wrong key', () => {
    const found = read(marked, RATE, KEY ^ 1n);
    expect(found.ok).toBe(false);
  });

  it('reports silence and a track too short to read as nothing', () => {
    expect(read(new Float32Array(RATE * 20)).reason).toBe('none');
    expect(read(new Float32Array(100)).reason).toBe('none');
    expect(read(new Float32Array([0.1])).reason).toBe('none');
  });

  it('calls a frame with a wrong checksum damaged, and never ok', () => {
    const bad = frame(PAYLOAD);
    bad[bad.length - 1] ^= 0x55;
    const audio = core.ssEmbed(host, bad, splitKey(KEY), RATE, -20);
    const found = read(audio);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('damaged');
    expect(Array.from(found.frame)).toEqual(Array.from(bad));
  });

  it('refuses a rate it cannot work at', () => {
    expect(() => detect(core, host, { key: KEY, sampleRate: 100 })).toThrow();
  });
});

describe('through the attack list', () => {
  const attacked = (id, param, seed = 0) => core.attack(id, param, RATE, marked, seed);

  it('survives a gain change', () => {
    for (const db of [-6, -0.5, 3]) {
      expect(read(attacked(ATTACKS.GAIN_DB, db)).ok, `${db} dB`).toBe(true);
    }
  });

  it('survives a time shift and a crop, finding the start blind', () => {
    expect(read(attacked(ATTACKS.TIME_SHIFT, 1000)).ok).toBe(true);
    expect(read(attacked(ATTACKS.CROP_FRACTION, 0.05)).ok).toBe(true);
  });

  it('survives resampling when told the new rate', () => {
    const ratio = 48000 / 44100;
    expect(read(attacked(ATTACKS.RESAMPLE, ratio), RATE * ratio).ok).toBe(true);
  });

  it('survives dither and moderate white noise', () => {
    expect(read(attacked(ATTACKS.DITHER, 48, 1)).ok).toBe(true);
    expect(read(attacked(ATTACKS.WHITE_NOISE, 30, 3)).ok).toBe(true);
  });

  it('does not survive being destroyed, and says so rather than guessing', () => {
    // White noise 6 dB below the peak is far louder than the mark. The result has to be a refusal.
    const found = read(attacked(ATTACKS.WHITE_NOISE, 6, 9));
    expect(found.ok).toBe(false);
  });

  it('finds nothing in a marked track read at the wrong rate', () => {
    // Without the rate the reader cannot undo a resample. It must not report a payload anyway.
    const ratio = 48000 / 44100;
    expect(read(attacked(ATTACKS.RESAMPLE, ratio), RATE).ok).toBe(false);
  });
});
