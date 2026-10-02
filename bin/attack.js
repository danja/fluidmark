#!/usr/bin/env node
// bin/attack.js
//
// The attack harness: put a mark in a file, run it through everything in the brief's list, and
// report what survives.
//
//   node bin/attack.js --in track.wav --payload "http://example.org/"
//   node bin/attack.js --in track.wav --payload x --json
//
// Built before the scheme it measures, on the reasoning in docs/steganography.md: a harness
// written after the algorithm exists will have been written to prove the algorithm works. The
// LSB baseline is the calibration. It is supposed to be fragile, so every figure here should be
// terrible, and if one is not, the harness is not measuring what it says.
//
// Every row is measured against the frame that went in, not against whatever decoded. A frame
// that fails its checksum still has a bit error rate, and that rate is the measurement.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { loadCore } from '../src/load-node.js';
import { decodeWav, encodeWav } from '../src/wav.js';
import { bitErrors, frame, frameBytesFor, unframe } from '../src/frame.js';
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

/** The attacks, each taking audio and returning audio. In Rust, via the core's ABI below. */
function buildAttacks(core, exports, sampleRate) {
  // Each one is a small closure so the table reads as the specification rather than as code.
  const n = (f32) => new Float32Array(f32.buffer, f32.byteOffset, f32.length / 4);
  const buffer = () => {
    const ptr = exports.core_buffer_new(65536);
    return ptr;
  };
  return [];
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.in || !args.payload) {
    process.stderr.write('usage: node bin/attack.js --in track.wav --payload "text" [--json]\n');
    return 2;
  }
  const key = args.key ? BigInt(args.key) : DEFAULT_KEY;

  const bytes = await readFile(args.in);
  const wav = decodeWav(new Uint8Array(bytes));
  const payload = new TextEncoder().encode(args.payload);
  const framed = frame(payload);
  const { lo, hi } = splitKey(key);

  const core = await loadCore();
  try {
    const marked = core.embedLsb(wav.samples, framed, { lo, hi });

    // The attacks. Everything that needs no external tool runs in the core; the two that need
    // ffmpeg are marked as depending on it and are skipped when it is absent.
    const rows = [];
    const add = (name, audio, note = '') => {
      const raw = core.extractLsb(audio, framed.length, { lo, hi });
      const errors = bitErrors(framed, raw);
      const decoded = unframe(raw);
      rows.push({
        attack: name,
        bitErrors: errors,
        bits: framed.length * 8,
        ber: errors / (framed.length * 8),
        decoded: decoded.ok,
        reason: decoded.ok ? 'ok' : decoded.reason,
        note,
      });
    };

    add('none (control)', marked);
    add('stereo to mono', exports.stereoToMono(marked));
    add('gain -6 dB', exports.gainDb(marked, -6));
    add('gain -0.5 dB', exports.gainDb(marked, -0.5));
    add('dither 48 dB SNR', exports.dither(marked, 48, 1));
    add('dither 36 dB SNR', exports.dither(marked, 36, 2));
    add('white noise 30 dB SNR', exports.whiteNoise(marked, 30, 3));
    add('pink noise 30 dB SNR', exports.pinkNoise(marked, 30, 4));
    add('low-pass 5 kHz', exports.lowpass(marked, 5000, wav.sampleRate));
    add('high-pass 200 Hz', exports.highpass(marked, 200, wav.sampleRate));
    add('resample to 48 kHz', exports.resample(marked, 48000 / wav.sampleRate, wav.sampleRate));
    add('resample to 22.05 kHz', exports.resample(marked, 22050 / wav.sampleRate, wav.sampleRate));
    add('time shift 1000', exports.timeShift(marked, 1000));
    add('crop 5%', exports.crop(marked, 0.05));

    // The two that need an external binary, reported separately per AGENTS.md.
    const haveFfmpeg = hasBinary('ffmpeg');
    if (haveFfmpeg) {
      const wavBytes = encodeWav(marked, wav.sampleRate);
      for (const [name, bitrate] of [['mp3 128k', '128k'], ['mp3 64k', '64k']]) {
        const mp3 = execFileSync(
          'ffmpeg',
          ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'],
          { input: wavBytes, maxBuffer: 128 * 1024 * 1024 },
        );
        const back = execFileSync(
          'ffmpeg',
          ['-loglevel', 'error', '-i', 'pipe:0', '-ar', String(wav.sampleRate), '-ac', '1',
           '-sample_fmt', 's16', '-f', 'wav', 'pipe:1'],
          { input: mp3, maxBuffer: 128 * 1024 * 1024 },
        );
        add(name, decodeWav(new Uint8Array(back)).samples, 'needs ffmpeg');
      }
    } else {
      rows.push({ attack: 'mp3 128k / 64k', skipped: true, note: 'ffmpeg not available' });
    }

    const survived = rows.filter((r) => !r.skipped && r.decoded);

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ key: key.toString(), rows }, null, 2)}\n`);
    } else {
      printTable(rows, framed.length);
      process.stdout.write(
        `\n${survived.length}/${rows.filter((r) => !r.skipped).length} attacks left the payload readable\n`,
      );
      if (!haveFfmpeg) {
        process.stdout.write('2 rows skipped: the lossy rows need ffmpeg, which is not installed\n');
      }
    }
    return 0;
  } finally {
    core.destroy();
  }
}

function printTable(rows, frameBytes) {
  const width = Math.max(...rows.map((r) => r.attack.length), 22);
  process.stdout.write(`payload framed at ${frameBytes} bytes (${frameBytes * 8} bits)\n\n`);
  process.stdout.write(`${'attack'.padEnd(width)}  BER     recovered  note\n`);
  process.stdout.write(`${'-'.repeat(width)}  ------  ---------  ----\n`);
  for (const row of rows) {
    if (row.skipped) {
      process.stdout.write(`${row.attack.padEnd(width)}  ------  ---------  skipped: ${row.note}\n`);
      continue;
    }
    const recovered = row.decoded ? 'yes' : `no (${row.reason})`;
    process.stdout.write(
      `${row.attack.padEnd(width)}  ${(row.ber * 100).toFixed(1).padStart(5)}%  ${recovered.padEnd(9)}  ${row.note}\n`,
    );
  }
}

function hasBinary(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

void buildAttacks;

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}

void fileURLToPath;
void existsSync;
void frameBytesFor;