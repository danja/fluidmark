// src/synth.js
//
// A deterministic stand-in for a music track, for the harness and the tests.
//
// Decaying harmonic notes over a changing chord, a noisy percussive hit on every beat, and a
// little broadband noise. It is not music and it is not a recording, but it is not a tone either:
// a single tone is the host that flatters every detector, and the AGENTS.md rule about fakes
// applies. Real tracks are the real test and need a person (`HUMANS.md`).

const NOTES = [110.0, 138.6, 164.8, 196.0, 220.0, 261.6, 329.6];

/** A small deterministic generator, so the same seed gives the same track on every machine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mono samples in -1..1. */
export function synthTrack(seconds, sampleRate = 44100, seed = 1) {
  const n = Math.round(seconds * sampleRate);
  const random = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const beat = Math.floor(t * 2);
    const phase = (t * 2) % 1;
    let v = 0;
    for (let h = 0; h < 3; h += 1) {
      const f = NOTES[(beat * 3 + h * 2) % NOTES.length];
      for (let harmonic = 1; harmonic <= 5; harmonic += 1) {
        v += (0.25 / harmonic) * Math.exp(-1.5 * phase) * Math.sin(2 * Math.PI * f * harmonic * t);
      }
    }
    const noise = random() - 0.5;
    out[i] = 0.4 * v + 0.5 * Math.exp(-18 * phase) * noise + 0.02 * noise;
  }
  return out;
}
