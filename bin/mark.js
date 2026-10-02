#!/usr/bin/env node
// bin/mark.js
//
// Write a payload into a WAV, or read one out of it.
//
//   node bin/mark.js --in track.wav --payload "http://example.org/" --out marked.wav
//   node bin/mark.js --in marked.wav --read
//
// Reads a mono 16-bit WAV and writes a mono 16-bit WAV, which is what the reference produced
// except that the reference handed back an MP3. See docs/web.md for why that is a change.

import { readFile, writeFile } from 'node:fs/promises';
import { loadCore } from '../src/load-node.js';
import { mark, read } from '../src/mark.js';
import { decodeWav, encodeWav } from '../src/wav.js';

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
  node bin/mark.js --in track.wav --payload "text" --out marked.wav
  node bin/mark.js --in marked.wav --read
  node bin/mark.js --in marked.wav --read --out recovered.txt

--read prints the payload. Without it, --payload is written into the input and --out is needed.
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

  const core = await loadCore();
  try {
    const bytes = await readFile(args.in);
    const wav = decodeWav(new Uint8Array(bytes));

    if (args.read) {
      const result = read(core, wav.samples);
      if (result.ok) {
        process.stdout.write(`${result.text}\n`);
        if (args.out) {
          await writeFile(args.out, `${result.text}\n`);
        }
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

    if (!args.payload) {
      process.stderr.write('nothing to do: pass --payload to write a mark, or --read\n');
      return 2;
    }
    if (!args.out) {
      process.stderr.write('--out is needed when writing a mark\n');
      return 2;
    }

    const tones = mark(core, args.payload);
    await writeFile(args.out, encodeWav(tones, wav.sampleRate));
    const seconds = (tones.length / wav.sampleRate).toFixed(2);
    process.stdout.write(
      `marked ${wav.sampleRate} Hz with ${tones.length} samples (${seconds} s) -> ${args.out}\n`,
    );
    return 0;
  } finally {
    core.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}