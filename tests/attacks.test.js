// tests/attacks.test.js
//
// The attack harness, and the calibration that makes its numbers mean something.
//
// The important test here is `the LSB baseline is destroyed by everything`. If that ever stops
// being true, the harness is broken rather than the scheme having improved, and a green suite
// would be reporting a number nobody should trust. So it is asserted, along with the control
// that catches the other direction: a harness that destroyed everything would also look fine.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCore } from '../src/load-node.js';
import { ATTACKS, ATTACK_LIST } from '../src/attacks.js';
import { bitErrors, frame, unframe } from '../src/frame.js';
import { splitKey } from '../src/watermark.js';

const KEY = 0x0123_4567_89ab_cdefn;
const RATE = 44100;
const PAYLOAD = new TextEncoder().encode('http://danbri.org/foaf');

let core;
// Marked once and shared: embedding is deterministic, so there is no reason to redo it per test,
// and a describe body runs before `beforeAll`, so it cannot be done there.
let marked;

beforeAll(async () => {
  core = await loadCore();
  marked = core.embedLsb(audio(), FRAMED, splitKey(KEY));
});

afterAll(() => {
  if (core) core.destroy();
});

function audio(seconds = 2) {
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

const FRAMED = frame(PAYLOAD);
const BITS = FRAMED.length * 8;

/** Mark, attack, read back, and report. */
function run(marked, id, param, seed = 0) {
  const attacked = core.attack(id, param, RATE, marked, seed);
  const { lo, hi } = splitKey(KEY);
  const raw = core.extractLsb(attacked, FRAMED.length, { lo, hi });
  return {
    ber: bitErrors(FRAMED, raw) / BITS,
    decoded: unframe(raw).ok,
    length: attacked.length,
  };
}

describe('the harness', () => {
  it('leaves an untouched mark perfectly readable', () => {
    // The control. Without it a harness that destroyed everything would look like it worked.
    const result = run(marked, ATTACKS.GAIN_DB, 0); // a no-op parameter still round-trips
    expect(result.ber).toBe(0);
    expect(result.decoded).toBe(true);
  });

  it('measures near-random bit errors when the mark is destroyed', () => {
    const result = run(marked, ATTACKS.GAIN_DB, -6);
    // Random bits are 50% wrong. Anything near that is "the mark is gone", not "the mark is
    // partly there", and the difference matters when a real scheme sits between the two.
    expect(result.ber).toBeGreaterThan(0.35);
    expect(result.ber).toBeLessThan(0.65);
  });

  it('reports every attack in the list as fatal to the LSB baseline', () => {
    const survivors = [];
    for (const row of ATTACK_LIST) {
      const result = run(marked, row.id, row.param, row.seed ?? 0);
      if (result.decoded) survivors.push(row.name);
    }
    expect(survivors, `the LSB baseline survived ${survivors.join(', ')}`).toEqual([]);
  });

  it('covers the brief: gain, dither, noise, filtering, resampling, time and crop', () => {
    const ids = new Set(ATTACK_LIST.map((r) => r.id));
    for (const required of [
      ATTACKS.GAIN_DB,
      ATTACKS.DITHER,
      ATTACKS.WHITE_NOISE,
      ATTACKS.PINK_NOISE,
      ATTACKS.LOWPASS,
      ATTACKS.HIGHPASS,
      ATTACKS.RESAMPLE,
      ATTACKS.TIME_SHIFT,
      ATTACKS.CROP_FRACTION,
    ]) {
      expect(ids.has(required), `no attack with id ${required}`).toBe(true);
    }
  });
});

describe('the individual attacks do what they say', () => {
  it('a gain change moves the level', () => {
    const quiet = core.attack(ATTACKS.GAIN_DB, -6, RATE, marked);
    const before = marked[1000];
    const after = quiet[1000];
    expect(after).toBeLessThan(before);
    expect(after / before).toBeCloseTo(Math.pow(10, -6 / 20), 3);
  });

  it('downsampling shortens and upsampling lengthens', () => {
    expect(core.attack(ATTACKS.RESAMPLE, 0.5, RATE, marked).length).toBeLessThan(marked.length);
    expect(core.attack(ATTACKS.RESAMPLE, 2, RATE, marked).length).toBeGreaterThan(marked.length);
  });

  it('a time shift lengthens by the shift and starts with silence', () => {
    const shifted = core.attack(ATTACKS.TIME_SHIFT, 1000, RATE, marked);
    expect(shifted.length).toBe(marked.length + 1000);
    expect(shifted[0]).toBe(0);
    expect(shifted[1000]).toBeCloseTo(marked[0], 6);
  });

  it('a crop drops the requested fraction from the front', () => {
    const cropped = core.attack(ATTACKS.CROP_FRACTION, 0.25, RATE, marked);
    expect(cropped.length).toBeCloseTo(marked.length * 0.75, -2);
  });

  it('dither and noise actually change the samples', () => {
    for (const id of [ATTACKS.DITHER, ATTACKS.WHITE_NOISE, ATTACKS.PINK_NOISE]) {
      const attacked = core.attack(id, 40, RATE, marked, 7);
      let differing = 0;
      for (let i = 0; i < marked.length; i += 1) {
        if (attacked[i] !== marked[i]) differing += 1;
      }
      expect(differing, `attack ${id} changed nothing`).toBeGreaterThan(marked.length * 0.5);
    }
  });

  it('the filters change the signal without changing its length', () => {
    for (const id of [ATTACKS.LOWPASS, ATTACKS.HIGHPASS]) {
      const attacked = core.attack(id, 1000, RATE, marked);
      expect(attacked.length).toBe(marked.length);
      let differing = 0;
      for (let i = 0; i < marked.length; i += 1) {
        if (Math.abs(attacked[i] - marked[i]) > 1e-6) differing += 1;
      }
      expect(differing, `filter ${id} changed nothing`).toBeGreaterThan(marked.length * 0.5);
    }
  });

  it('refuses an attack it does not have', () => {
    expect(() => core.attack(9999, 1, RATE, marked)).toThrow(/CoreRangeError/);
  });

  it('refuses audio that is not audio', () => {
    expect(() => core.attack(ATTACKS.GAIN_DB, -6, RATE, [1, 2, 3])).toThrow(TypeError);
  });
});