#!/usr/bin/env node
// bin/false-positive.js
//
// How often does the reader claim a mark in audio that has none?
//
//   node bin/false-positive.js --dir ~/Music/album [--keys 50] [--jobs 4]
//
// The figure that decides whether the system is usable at all: a mark detector that finds marks
// in unmarked tracks is worse than none, because the claim it makes is a claim about someone's
// work. Every file is read under many different keys, since the reader is looking for a keyed
// pattern and a different key is a different pattern to see in the same music, so each file gives
// many independent chances to be wrong.
//
// Two outcomes count against it, and they are reported apart: `verified`, a payload that passed
// its checksum in a file that was never marked, and `damaged`, a header found and not verified,
// which the page would tell a person is "something found that does not check out".
//
// Nothing is copied or printed but counts and file names.

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../src/load-node.js';
import { readAudioFile } from '../src/audio-node.js';
import { detectRaw } from '../src/spread.js';

const SELF = fileURLToPath(import.meta.url);
const AUDIO = new Set(['.wav', '.flac', '.mp3', '.m4a', '.ogg']);

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

/** One file under `keys` keys, in this process. */
async function worker(file, keys) {
  const core = await loadCore();
  try {
    const audio = await readAudioFile(file);
    const counts = { verified: 0, damaged: 0, none: 0 };
    for (let k = 1; k <= keys; k += 1) {
      // Keys spread over the 64-bit range rather than 1, 2, 3, which are nearly the same input to a
      // generator seeded by xor.
      const key = (BigInt(k) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
      const found = detectRaw(core, audio.channelData, { key, sampleRate: audio.sampleRate });
      counts[found.status] += 1;
    }
    process.stdout.write(`${JSON.stringify({ file, frames: audio.frames, sampleRate: audio.sampleRate, ...counts })}\n`);
  } finally {
    core.destroy();
  }
}

function runWorker(file, keys) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SELF, '--worker', file, '--keys', String(keys)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      try {
        resolveRun(JSON.parse(out));
      } catch {
        resolveRun({ file, error: err.trim().split('\n').pop() || `exit ${code}` });
      }
    });
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.worker) {
    await worker(args.worker, Number(args.keys ?? 20));
    return 0;
  }
  if (!args.dir) {
    process.stderr.write('usage: node bin/false-positive.js --dir DIR [--keys 50] [--jobs 4]\n');
    return 2;
  }
  const keys = Number(args.keys ?? 50);
  const jobs = Math.max(1, Number(args.jobs ?? 4));
  const dir = resolve(args.dir);
  const files = (await readdir(dir)).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort().map((f) => join(dir, f));
  if (files.length === 0) {
    process.stderr.write(`no audio files in ${dir}\n`);
    return 2;
  }
  process.stderr.write(`${files.length} files, ${keys} keys each, ${jobs} at a time\n`);

  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next];
        next += 1;
        const r = await runWorker(file, keys);
        process.stderr.write(`  ${r.error ? 'FAILED' : 'done  '} ${basename(file)}${r.error ? `: ${r.error}` : ` verified ${r.verified} damaged ${r.damaged}`}\n`);
        results.push(r);
      }
    }),
  );

  const ok = results.filter((r) => !r.error);
  const trials = ok.reduce((n, r) => n + r.verified + r.damaged + r.none, 0);
  const verified = ok.reduce((n, r) => n + r.verified, 0);
  const damaged = ok.reduce((n, r) => n + r.damaged, 0);
  const hours = ok.reduce((n, r) => n + r.frames / r.sampleRate, 0) / 3600;
  process.stdout.write(
    `\n${trials} reads of ${ok.length} unmarked files (${hours.toFixed(2)} hours of audio), ${keys} keys each.\n` +
      `  reported as marked (verified): ${verified}\n` +
      `  reported as a damaged mark:    ${damaged}\n`,
  );
  // The rule of three: no events in n trials puts the true rate under 3/n with 95% confidence.
  const bound = (k) => (k === 0 && trials > 0 ? `under ${(300 / trials).toPrecision(2)}% at 95% confidence` : `${((100 * k) / trials).toFixed(3)}%`);
  process.stdout.write(`  rate of verified claims: ${bound(verified)}\n  rate of damaged claims:  ${bound(damaged)}\n`);
  const failed = results.filter((r) => r.error);
  if (failed.length) process.stdout.write(`${failed.length} file(s) could not be read: ${failed.map((r) => `${basename(r.file)} (${r.error})`).join('; ')}\n`);
  return verified > 0 ? 3 : 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
