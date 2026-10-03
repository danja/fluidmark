// tests/synth.test.js
//
// The synthetic host. Worth testing because every figure the spread-spectrum work produces
// depends on it being deterministic and being something other than a tone.

import { describe, expect, it } from 'vitest';
import { synthTrack } from '../src/synth.js';

function rms(x) {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / x.length);
}

describe('synthTrack', () => {
  it('is deterministic: the same seed gives the same samples', () => {
    expect(Array.from(synthTrack(0.5, 44100, 3))).toEqual(Array.from(synthTrack(0.5, 44100, 3)));
  });

  it('differs between seeds', () => {
    expect(Array.from(synthTrack(0.5, 44100, 1))).not.toEqual(Array.from(synthTrack(0.5, 44100, 2)));
  });

  it('has the length and range of a track', () => {
    const track = synthTrack(2, 22050, 1);
    expect(track.length).toBe(44100);
    expect(Math.max(...track.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(rms(track)).toBeGreaterThan(0.01);
  });

  it('is not a tone: the level changes from beat to beat', () => {
    const track = synthTrack(4, 44100, 1);
    const beat = 22050;
    const levels = [0, 1, 2, 3].map((b) => rms(track.slice(b * beat, (b + 1) * beat)));
    expect(Math.max(...levels) / Math.min(...levels)).toBeGreaterThan(1.05);
  });
});
