// tests/psycho.test.js
//
// The noise-to-mask ratio through the wrapper. The model itself is tested in `wasm/src/psycho.rs`; this
// is what only the wrapper can get wrong: the buffer plumbing, the refusals, and "nothing to judge"
// coming back as null and not as a number.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCore } from '../src/load-node.js';
import { embed } from '../src/spread.js';
import { synthTrack } from '../src/synth.js';

const RATE = 44100;
let core;
let host;

beforeAll(async () => {
  core = await loadCore();
  host = synthTrack(30, RATE, 5);
}, 60000);

afterAll(() => {
  if (core) core.destroy();
});

const payload = new TextEncoder().encode('urn:x:1');

describe('nmr', () => {
  it('judges a mark and returns the figures, all finite', () => {
    const marked = embed(core, host, payload, { key: 1n, sampleRate: RATE, strengthDb: -20 });
    const r = core.nmr(host, marked, RATE);
    expect(r.frames).toBeGreaterThan(50);
    expect(r.cells).toBeGreaterThan(r.frames);
    for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
    expect(r.aboveMinus6).toBeGreaterThanOrEqual(r.aboveThreshold);
    expect(r.worstFrameAt).toBeGreaterThanOrEqual(0);
    expect(r.worstFrameAt).toBeLessThan(1);
    expect(r.p95Db).toBeGreaterThanOrEqual(r.meanDb - 1);
  });

  it('puts a quieter mark further under the threshold, by about the difference', () => {
    const loud = core.nmr(host, embed(core, host, payload, { key: 1n, sampleRate: RATE, strengthDb: -20, level: 'relative' }), RATE);
    const quiet = core.nmr(host, embed(core, host, payload, { key: 1n, sampleRate: RATE, strengthDb: -32, level: 'relative' }), RATE);
    // 12 dB quieter in the mark is 12 dB in the ratio, give or take the bands that sit on the floor.
    expect(loud.meanDb - quiet.meanDb).toBeGreaterThan(9);
    expect(loud.meanDb - quiet.meanDb).toBeLessThan(13);
    expect(quiet.aboveThreshold).toBeLessThanOrEqual(loud.aboveThreshold);
  });

  it('says there is nothing to judge for identical files and for silence, as null', () => {
    expect(core.nmr(host, Float32Array.from(host), RATE)).toBeNull();
    const silence = new Float32Array(RATE * 2);
    expect(core.nmr(silence, silence, RATE)).toBeNull();
  });

  it('refuses what it cannot judge', () => {
    expect(() => core.nmr(host, host.slice(0, 1000), RATE)).toThrow(RangeError);
    expect(() => core.nmr([1], [1], RATE)).toThrow(TypeError);
    expect(() => core.nmr(host, host, 0)).toThrow();
    expect(() => core.nmr(new Float32Array(100), new Float32Array(100), RATE)).toThrow(/CoreLengthError/);
  });
});
