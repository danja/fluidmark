#!/usr/bin/env node
// bin/mark.js
//
// Write a payload into a WAV, or read one out of it.
//
//   node bin/mark.js --in track.wav --payload "http://example.org/" --out marked.wav
//   node bin/mark.js --in marked.wav --read
//
// The same operations the page does, on a WAV file, so a result from the page can be checked
// outside it. Both drive the one core. See `--help`, and docs/web.md for why this writes a WAV
// where the reference handed back an MP3.

import { readFile, writeFile } from 'node:fs/promises';
import { loadCore } from '../src/load-node.js';
import { mark, read } from '../src/mark.js';
import * as spread from '../src/spread.js';
import { keyFromText } from '../src/spread.js';
import { decodeWav, decodeWavChannels, encodeWav, encodeWavChannels } from '../src/wav.js';

/** Parse `--flag value` and `--flag` pairs. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument "${token}"`);
    }
    const name = token.slice(2);
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

const USAGE = `usage:
  node bin/mark.js --in track.wav --payload "text" --out marked.wav [--key phrase] [--scheme spread|tones]
  node bin/mark.js --in marked.wav --read [--key phrase] [--scheme spread|tones]

The default scheme is spread: a watermark hidden under the music, for a WAV of one to eight channels, 8 to 32 bit,
written back as 16-bit with the channels kept. It needs a track of about 15 to 50 seconds depending on the payload,
and says how long when it is too short. --key is a phrase; the same phrase is needed to read the mark back, and
without one the public default key is used, which anyone can use.

--scheme tones is the original audible scheme, from the reference: mono 16-bit WAV in, tones out.

--read prints the payload. Without it, --payload is written into the input and --out is needed.
Exit status: 0 found or written, 1 nothing found or damaged, 2 bad usage.
`;

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.in) {
    process.stderr.write(USAGE);
    return 2;
  }
  const scheme = args.scheme ?? 'spread';
  if (scheme !== 'spread' && scheme !== 'tones') {
    process.stderr.write(`unknown scheme "${scheme}": spread or tones\n`);
    return 2;
  }
  if (args.read === undefined && !args.payload) {
    process.stderr.write('nothing to do: pass --payload to write a mark, or --read\n');
    return 2;
  }
  if (!args.read && !args.out) {
    process.stderr.write('--out is needed when writing a mark\n');
    return 2;
  }

  const core = await loadCore();
  try {
    const bytes = new Uint8Array(await readFile(args.in));
    return scheme === 'spread' ? await spreadMain(core, args, bytes) : await tonesMain(core, args, bytes);
  } finally {
    core.destroy();
  }
}

async function spreadMain(core, args, bytes) {
  const wav = decodeWavChannels(bytes);
  const key = keyFromText(args.key === true ? '' : args.key);

  if (args.read) {
    const found = spread.detect(core, wav.channelData, { key, sampleRate: wav.sampleRate });
    if (found.ok) {
      const text = new TextDecoder().decode(found.payload);
      process.stdout.write(`${text}\n`);
      if (args.out) await writeFile(args.out, `${text}\n`);
      return 0;
    }
    process.stderr.write(
      found.reason === 'damaged'
        ? 'something was found but it does not check out, so it is not reported as a payload\n'
        : 'no mark found in this file (with this key)\n',
    );
    return 1;
  }

  const payload = new TextEncoder().encode(String(args.payload));
  const marked = spread.embed(core, wav.channelData, payload, { key, sampleRate: wav.sampleRate });
  await writeFile(args.out, encodeWavChannels(marked, wav.sampleRate));
  const seconds = (wav.frames / wav.sampleRate).toFixed(1);
  const copies = Math.floor(wav.frames / spread.minSamples(core, payload.length, wav.sampleRate));
  process.stdout.write(
    `marked ${wav.channels} channel${wav.channels === 1 ? '' : 's'}, ${wav.sampleRate} Hz, ${seconds} s, ` +
      `${copies} cop${copies === 1 ? 'y' : 'ies'} of the mark -> ${args.out}\n`,
  );
  if (wav.bitsPerSample !== 16) {
    process.stdout.write(`note: the input was ${wav.bitsPerSample}-bit and the output is 16-bit\n`);
  }
  return 0;
}

async function tonesMain(core, args, bytes) {
  const wav = decodeWav(bytes);
  if (args.read) {
    const result = read(core, wav.samples);
    if (result.ok) {
      process.stdout.write(`${result.text}\n`);
      if (args.out) await writeFile(args.out, `${result.text}\n`);
      return 0;
    }
    // Three outcomes, kept apart: nothing found, found and damaged, or a bad file.
    const message =
      result.reason === 'no-mark'
        ? 'no mark found in this file'
        : `something was found but it does not check out (${result.reason})`;
    process.stderr.write(`${message}\n`);
    return 1;
  }
  const tones = mark(core, args.payload);
  await writeFile(args.out, encodeWav(tones, wav.sampleRate));
  const seconds = (tones.length / wav.sampleRate).toFixed(2);
  process.stdout.write(
    `marked ${wav.sampleRate} Hz with ${tones.length} samples (${seconds} s) -> ${args.out}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}