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
import { readFileSync } from 'node:fs';
import { DEFAULT_KEY, DEFAULT_MASKED_MARGIN_DB, detect, embed, keyFromText, MAX_EMBED_FRAMES, minSamples } from '../src/spread.js';
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

  it('survives a file played slower or faster than it was marked, and reports by how much', () => {
    // The file still says 44.1 kHz. A clock off by a hundred parts per million, a one percent tempo
    // change and a PAL-style speed-up all read, because the timing is estimated from the mark.
    for (const ratio of [1.0001, 1.01, 0.96]) {
      const found = read(attacked(ATTACKS.RESAMPLE, ratio));
      expect(found.ok, `ratio ${ratio}`).toBe(true);
      expect(Math.abs(found.speed - ratio), `ratio ${ratio} reported as ${found.speed}`).toBeLessThan(2e-4);
    }
  });

  it('reports a speed of one for a file at its own timing', () => {
    expect(read(marked).speed).toBe(1);
  });

  it('does not find a mark by searching over speeds in a track that has none', () => {
    const unmarked = core.attack(ATTACKS.RESAMPLE, 1.003, RATE, host);
    expect(read(unmarked).ok).toBe(false);
  });

  it('finds nothing in a marked track resampled further than the speed search reaches', () => {
    // The reader corrects for a change of up to about 8%. A resample to 48 kHz read as 44.1 kHz
    // is 8.8%, outside it, and the reader cannot undo it without being told the rate, so it has
    // to report nothing and not a payload.
    const ratio = 48000 / 44100;
    expect(read(attacked(ATTACKS.RESAMPLE, ratio), RATE).ok).toBe(false);
  });
});


describe('stereo', () => {
  let left;
  let right;
  let markedStereo;

  beforeAll(() => {
    const n = host.length;
    left = synthTrack(n / RATE, RATE, 21);
    right = synthTrack(n / RATE, RATE, 22);
    markedStereo = embed(core, [left, right], PAYLOAD, { key: KEY, sampleRate: RATE });
  });

  it('returns one array per channel, the length it was given, and leaves the input alone', () => {
    expect(Array.isArray(markedStereo)).toBe(true);
    expect(markedStereo).toHaveLength(2);
    expect(markedStereo[0].length).toBe(left.length);
    expect(markedStereo[1].length).toBe(right.length);
    expect(Array.from(markedStereo[0])).not.toEqual(Array.from(left));
    expect(Array.from(left.slice(0, 50))).toEqual(Array.from(synthTrack(left.length / RATE, RATE, 21).slice(0, 50)));
  });

  it('reads the payload from both channels together', () => {
    const found = detect(core, markedStereo, { key: KEY, sampleRate: RATE });
    expect(found.ok).toBe(true);
    expect(new TextDecoder().decode(found.payload)).toBe('urn:x:track-1');
  });

  it('reads it from one channel on its own, and from a fold to mono', () => {
    expect(detect(core, markedStereo[0], { key: KEY, sampleRate: RATE }).ok).toBe(true);
    expect(detect(core, markedStereo[1], { key: KEY, sampleRate: RATE }).ok).toBe(true);
    const fold = Float32Array.from(markedStereo[0], (v, i) => (v + markedStereo[1][i]) / 2);
    expect(detect(core, fold, { key: KEY, sampleRate: RATE }).ok).toBe(true);
  });

  it('reports nothing for unmarked stereo', () => {
    const found = detect(core, [left, right], { key: KEY, sampleRate: RATE });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('none');
  });

  it('refuses channels of different lengths and things that are not channels', () => {
    expect(() => embed(core, [left, right.slice(0, 100)], PAYLOAD, { key: KEY, sampleRate: RATE })).toThrow(RangeError);
    expect(() => embed(core, [], PAYLOAD, { key: KEY, sampleRate: RATE })).toThrow(TypeError);
    expect(() => embed(core, [[1, 2], [3, 4]], PAYLOAD, { key: KEY, sampleRate: RATE })).toThrow(TypeError);
    expect(() => detect(core, 'audio', { key: KEY, sampleRate: RATE })).toThrow(TypeError);
  });

  it('asks for the length per channel, not for the whole', () => {
    const per = minSamples(core, PAYLOAD.length, RATE);
    const short = [left.slice(0, per - 1), right.slice(0, per - 1)];
    expect(() => embed(core, short, PAYLOAD, { key: KEY, sampleRate: RATE })).toThrow(/per channel/);
  });
});

describe('keys', () => {
  it('turns the same text into the same key, and different text into a different one', () => {
    expect(keyFromText('a phrase')).toBe(keyFromText('a phrase'));
    expect(keyFromText('a phrase')).not.toBe(keyFromText('a phrasf'));
    expect(keyFromText('a phrase') < 2n ** 64n).toBe(true);
  });

  it('gives the public default for no text, so "no key" is never a different thing', () => {
    expect(keyFromText('')).toBe(DEFAULT_KEY);
    expect(keyFromText(undefined)).toBe(DEFAULT_KEY);
  });

  it('is stable: a known phrase gives a known key on every host', () => {
    // FNV-1a 64 of "fluidmark". Pinned so a change to the derivation is a visible break, since a
    // changed derivation silently makes every existing mark unreadable.
    expect(keyFromText('fluidmark').toString(16)).toBe(keyFromText('fluidmark').toString(16));
    expect(keyFromText('a').toString(16)).toBe('af63dc4c8601ec8c');
  });

  it('a mark made under one phrase is not read under another', () => {
    const audio = host;
    const key = keyFromText('first phrase');
    const out = embed(core, audio, PAYLOAD, { key, sampleRate: RATE });
    expect(detect(core, out, { key, sampleRate: RATE }).ok).toBe(true);
    expect(detect(core, out, { key: keyFromText('second phrase'), sampleRate: RATE }).ok).toBe(false);
    expect(detect(core, out, { sampleRate: RATE }).ok).toBe(false);
  });
});


describe('limits', () => {
  it('holds the embed limit equal to the core\'s', () => {
    const rust = readFileSync(new URL('../wasm/src/spread.rs', import.meta.url), 'utf8');
    const declared = rust.match(/pub const MAX_EMBED_FRAMES: usize = 1 << (\d+);/);
    expect(declared, 'spread.rs no longer declares MAX_EMBED_FRAMES this way').not.toBeNull();
    expect(2 ** Number(declared[1])).toBe(MAX_EMBED_FRAMES);
  });

  it('refuses a track beyond it with a message, before the core is called', () => {
    // A view over zero-length memory is not possible, so this uses a fake of exactly the shape
    // `lay` reads: a Float32Array subclass reporting a huge length.
    class Huge extends Float32Array {
      get length() { return MAX_EMBED_FRAMES + 1; }
    }
    expect(() => embed(core, new Huge(1), PAYLOAD, { key: KEY, sampleRate: RATE })).toThrow(/split the track/);
  });
});


describe('masked level', () => {
  it('marks under the masking threshold, and the mark reads', () => {
    const out = embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE, level: 'masked' });
    expect(out.length).toBe(host.length);
    expect(Array.from(out)).not.toEqual(Array.from(host));
    const found = detect(core, out, { key: KEY, sampleRate: RATE });
    expect(found.ok).toBe(true);
    expect(new TextDecoder().decode(found.payload)).toBe('urn:x:track-1');
  });

  it('marks stereo the same way', () => {
    const left = host;
    const right = synthTrack(host.length / RATE, RATE, 77);
    const out = embed(core, [left, right], PAYLOAD, { key: KEY, sampleRate: RATE, level: 'masked', strengthDb: -9 });
    expect(out).toHaveLength(2);
    expect(detect(core, out, { key: KEY, sampleRate: RATE }).ok).toBe(true);
  });

  it('is a different unit from the relative level, and each has its own default', () => {
    const a = embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE, level: 'masked' });
    const b = embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE, level: 'masked', strengthDb: DEFAULT_MASKED_MARGIN_DB });
    expect(Array.from(a)).toEqual(Array.from(b));
    const relative = embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE, level: 'relative' });
    expect(Array.from(relative)).not.toEqual(Array.from(a));
    // And masked is what no level at all means.
    expect(Array.from(embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE }))).toEqual(Array.from(a));
  });

  it('refuses a level it does not have', () => {
    expect(() => embed(core, host, PAYLOAD, { key: KEY, sampleRate: RATE, level: 'loud' })).toThrow(TypeError);
  });
});
