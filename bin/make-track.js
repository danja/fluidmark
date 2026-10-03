#!/usr/bin/env node
// bin/make-track.js
//
// Write the synthetic test track to a WAV, for `bin/attack.js` and for listening to.
//
//   node bin/make-track.js --out track.wav [--seconds 60] [--rate 44100] [--seed 1]

import { writeFile } from 'node:fs/promises';
import { synthTrack } from '../src/synth.js';
import { encodeWav } from '../src/wav.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
if (!args.out) {
  process.stderr.write('usage: node bin/make-track.js --out track.wav [--seconds 60] [--rate 44100] [--seed 1]\n');
  process.exit(2);
}
const rate = Number(args.rate ?? 44100);
const samples = synthTrack(Number(args.seconds ?? 60), rate, Number(args.seed ?? 1));
await writeFile(args.out, encodeWav(samples, rate));
process.stdout.write(`wrote ${args.out}: ${samples.length} samples at ${rate} Hz\n`);
