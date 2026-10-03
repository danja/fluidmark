#!/usr/bin/env node
// bin/attack.js
//
// The attack harness: put a mark in a file, run it through everything in the brief's list, and
// report what survives.
//
//   node bin/attack.js --in track.wav --payload "http://example.org/"
//   node bin/attack.js --in track.wav --payload x --json
//   node bin/attack.js --in track.wav --payload x --out marked.wav
//
// Built before the scheme it measures, on the reasoning in docs/steganography.md: a harness
// written after the algorithm exists will have been written to prove the algorithm works. The LSB
// baseline is the calibration. It is supposed to be fragile, so every figure here should be
// terrible, and if one is not, the harness is not measuring what it says.
//
// Every row is measured against the frame that went in, not against whatever decoded. A frame
// that fails its checksum still has a bit error rate, and that rate is the measurement.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { loadCore } from '../src/load-node.js';
import { ATTACK_LIST, REMOVAL_LIST } from '../src/attacks.js';
import { bitErrors, frame, unframe } from '../src/frame.js';
import { decodeWav, encodeWav } from '../src/wav.js';
import { splitKey } from '../src/watermark.js';

const DEFAULT_KEY = 0x0123_4567_89ab_cdefn;

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

function hasBinary(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A lossy round trip through ffmpeg, or null when ffmpeg is not installed. */
function lossyRoundTrip(wavBytes, sampleRate, bitrate) {
  try {
    const mp3 = execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'],
      { input: wavBytes, maxBuffer: 128 * 1024 * 1024 },
    );
    const back = execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-i', 'pipe:0', '-ar', String(sampleRate), '-ac', '1',
       '-sample_fmt', 's16', '-f', 'wav', 'pipe:1'],
      { input: mp3, maxBuffer: 128 * 1024 * 1024 },
    );
    return decodeWav(new Uint8Array(back)).samples;
  } catch {
    return null;
  }
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.in || !args.payload) {
    process.stderr.write(
      'usage: node bin/attack.js --in track.wav --payload "text" [--json] [--out marked.wav]\n',
    );
    return 2;
  }
  const key = args.key ? BigInt(args.key) : DEFAULT_KEY;

  const wav = decodeWav(new Uint8Array(await readFile(args.in)));
  const payload = new TextEncoder().encode(String(args.payload));
  const framed = frame(payload);
  const bits = framed.length * 8;
  const { lo, hi } = splitKey(key);

  const core = await loadCore();
  try {
    const marked = core.embedLsb(wav.samples, framed, { lo, hi });

    if (args.out) {
      await writeFile(args.out, encodeWav(marked, wav.sampleRate));
    }

    const rows = [];
    const add = (name, samples, note = '') => {
      const raw = core.extractLsb(samples, framed.length, { lo, hi });
      const errors = bitErrors(framed, raw);
      const decoded = unframe(raw);
      rows.push({
        attack: name,
        bitErrors: errors,
        bits,
        ber: errors / bits,
        decoded: decoded.ok,
        reason: decoded.ok ? 'ok' : decoded.reason,
        note,
      });
    };

    // The control first, so every other row has something to be compared against in the output.
    add('none (control)', marked);
    for (const row of ATTACK_LIST) {
      add(row.name, core.attack(row.id, row.param, wav.sampleRate, marked, row.seed ?? 0), row.note ?? '');
    }

    // Removal, after the degradation rows and labelled as its own thing, because "how do I get
    // rid of this" and "what does processing do to this" are different questions and a table that
    // mixed them would answer neither.
    for (const row of REMOVAL_LIST) {
      add(row.name, core.attack(row.id, row.param, wav.sampleRate, marked, row.seed ?? 0), 'needs no key');
    }

    // The lossy rows need an external binary, so they are reported separately whether or not it
    // is there, per AGENTS.md on environment-dependent tests.
    const haveFfmpeg = hasBinary('ffmpeg');
    if (haveFfmpeg) {
      const markedWav = encodeWav(marked, wav.sampleRate);
      for (const bitrate of ['128k', '64k']) {
        const samples = lossyRoundTrip(markedWav, wav.sampleRate, bitrate);
        if (samples) add(`mp3 ${bitrate}`, samples, 'needs ffmpeg');
        else rows.push({ attack: `mp3 ${bitrate}`, skipped: true, note: 'ffmpeg failed' });
      }
    } else {
      for (const bitrate of ['128k', '64k']) {
        rows.push({ attack: `mp3 ${bitrate}`, skipped: true, note: 'ffmpeg not installed' });
      }
    }

    const ran = rows.filter((r) => !r.skipped);
    const survived = ran.filter((r) => r.decoded);

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ key: key.toString(), payloadBytes: payload.length, rows }, null, 2)}\n`);
    } else {
      printTable(rows, framed.length, bits, wav.sampleRate);
      process.stdout.write(
        `\n${survived.length}/${ran.length} attacks left the payload readable` +
          ` (control included)\n`,
      );
    }
    return 0;
  } finally {
    core.destroy();
  }
}

function printTable(rows, frameBytes, bits, sampleRate) {
  const width = Math.max(...rows.map((r) => r.attack.length), 22);
  process.stdout.write(
    `LSB baseline: ${frameBytes} byte frame, ${bits} bits, ${sampleRate} Hz mono\n\n`,
  );
  process.stdout.write(`${'attack'.padEnd(width)}   BER    recovered  note\n`);
  process.stdout.write(`${'-'.repeat(width)}  ------  ---------  ----\n`);
  for (const row of rows) {
    if (row.skipped) {
      process.stdout.write(
        `${row.attack.padEnd(width)}  ------  ---------  skipped: ${row.note}\n`,
      );
      continue;
    }
    const recovered = row.decoded ? 'yes' : `no (${row.reason})`;
    process.stdout.write(
      `${row.attack.padEnd(width)}  ${`${(row.ber * 100).toFixed(1)}%`.padStart(5)}   ${recovered.padEnd(9)}  ${row.note}\n`,
    );
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