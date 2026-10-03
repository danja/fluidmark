#!/usr/bin/env node
// bin/audibility.js
//
// How far under the threshold of what the music masks does a mark sit, by a masking model.
//
//   node bin/audibility.js --in track.wav [--strengths -20,-26,-32,-38] [--level relative|masked] [--key phrase] [--payload text]
//   node bin/audibility.js --in track.wav --marked marked.wav
//
// **An objective proxy, not a verdict.** SNR does not say what is audible and neither, finally, does
// this: it is a simplified masking model (`wasm/src/psycho.rs`), assuming a full-scale sine is 96 dB SPL,
// fitted to listening tests of other noise on other music. It is better than SNR because it knows a loud
// tone hides noise near it and quiet passages hide almost nothing. Use it to compare settings and to find
// the passage where the mark is closest to being heard, and then listen there. Only a listener decides
// whether the mark is inaudible (HUMANS.md).
//
// The figures are per channel. For a stereo file the worse of the two channels is the one reported.

import { loadCore } from '../src/load-node.js';
import { readAudioFile } from '../src/audio-node.js';
import * as spread from '../src/spread.js';
import { DEFAULT_KEY, keyFromText } from '../src/spread.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"`);
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const clock = (fraction, seconds) => {
  const t = Math.round(fraction * seconds);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** The worse channel's figures: the channel with the higher mean, since that is where it is closer to being heard. */
function judge(core, original, marked, sampleRate) {
  const per = original.map((channel, c) => core.nmr(channel, marked[c], sampleRate));
  const some = per.filter(Boolean);
  if (some.length === 0) return null;
  return some.reduce((worst, r) => (r.meanDb > worst.meanDb ? r : worst));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.in) {
    process.stderr.write('usage: node bin/audibility.js --in track.wav [--strengths -20,-26,-32,-38] [--level relative|masked] [--key phrase] [--payload text]\n       node bin/audibility.js --in track.wav --marked marked.wav\n');
    return 2;
  }
  const core = await loadCore();
  try {
    const original = await readAudioFile(args.in);
    const seconds = original.frames / original.sampleRate;
    const header = `${original.channels} channel${original.channels === 1 ? '' : 's'}, ${original.sampleRate} Hz, ${seconds.toFixed(0)} s. Masking model, full scale taken as 96 dB SPL.\n` +
      'Negative is under the model\'s threshold. A proxy for audibility, not a verdict: listen where the worst frame is.\n\n';
    process.stdout.write(header);

    const rows = [];
    if (args.marked) {
      const marked = await readAudioFile(args.marked);
      if (marked.frames !== original.frames || marked.channels !== original.channels) {
        throw new Error(`the marked file is ${marked.frames} frames of ${marked.channels} channels and the original is ${original.frames} of ${original.channels}`);
      }
      rows.push({ label: 'this file', r: judge(core, original.channelData, marked.channelData, original.sampleRate) });
    } else {
      const key = args.key ? keyFromText(args.key) : DEFAULT_KEY;
      const payload = new TextEncoder().encode(String(args.payload ?? 'http://danbri.org/foaf'));
      const needed = core.ssMinSamples(10 + payload.length, original.sampleRate);
      if (original.frames < needed) throw new Error(`the track is ${seconds.toFixed(0)} s and one copy of the mark needs ${(needed / original.sampleRate).toFixed(0)} s`);
      const level = args.level ?? 'relative';
      const defaults = level === 'masked' ? '-3,-6,-9,-12' : '-20,-26,-32,-38';
      for (const strength of String(args.strengths ?? defaults).split(',').map(Number)) {
        const marked = spread.embed(core, original.channelData, payload, { key, sampleRate: original.sampleRate, strengthDb: strength, level });
        rows.push({ label: `${strength} dB`, r: judge(core, original.channelData, marked, original.sampleRate) });
      }
    }

    process.stdout.write('mark         mean NMR   95th pct   over threshold   within 6 dB   worst frame\n');
    process.stdout.write('-----------  ---------  ---------  ---------------  ------------  -----------\n');
    for (const { label, r } of rows) {
      if (!r) {
        process.stdout.write(`${label.padEnd(11)}  nothing to judge\n`);
        continue;
      }
      process.stdout.write(
        `${label.padEnd(11)}  ${`${r.meanDb.toFixed(1)} dB`.padStart(9)}  ${`${r.p95Db.toFixed(1)} dB`.padStart(9)}  ` +
          `${pct(r.aboveThreshold).padStart(15)}  ${pct(r.aboveMinus6).padStart(12)}  ` +
          `${`${r.worstFrameDb.toFixed(1)} dB at ${clock(r.worstFrameAt, seconds)}`}\n`,
      );
    }
    return 0;
  } finally {
    core.destroy();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
