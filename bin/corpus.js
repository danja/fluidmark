#!/usr/bin/env node
// bin/corpus.js
//
// Run the attack harness over every audio file in a directory and say how many survived each attack.
//
//   node bin/corpus.js --dir ~/Music/album [--strength -20] [--key 2] [--payload "text"] [--jobs 4] [--out table.md]
//
// One track tells you about that track. A table over a whole album tells you whether a result is a
// property of the scheme or of the one file it was measured on, which is what the early figures on
// two excerpts could not say. Each file goes through `bin/attack.js --json`, so there is one
// implementation of the harness and this only aggregates it.
//
// Nothing is copied: files are read where they are, marked in memory, and only counts and names are
// printed, so a corpus of someone's own unreleased music can be measured without it leaving the
// directory.

import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('./attack.js', import.meta.url));
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

/** One file through the harness. Resolves to the parsed rows, or an error that names the file. */
function runOne(file, { payload, key, strength }) {
  return new Promise((resolveRun) => {
    const argv = [HARNESS, '--in', file, '--payload', payload, '--scheme', 'spread', '--key', key, '--strength', strength, '--json'];
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      // Exit 3 is a false positive on the unmarked control, which is a result and not a failure.
      if (code !== 0 && code !== 3) {
        resolveRun({ file, error: (err.trim().split('\n').pop() || `exit ${code}`) });
        return;
      }
      try {
        resolveRun({ file, ...JSON.parse(out) });
      } catch {
        resolveRun({ file, error: 'the harness printed something that is not JSON' });
      }
    });
  });
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.dir) {
    process.stderr.write('usage: node bin/corpus.js --dir DIR [--strength -20] [--key 2] [--payload "text"] [--jobs 4] [--limit N] [--out table.md]\n');
    return 2;
  }
  const options = {
    payload: args.payload ?? 'http://danbri.org/foaf',
    key: String(args.key ?? 2),
    strength: String(args.strength ?? -20),
  };
  const jobs = Math.max(1, Number(args.jobs ?? 4));

  const dir = resolve(args.dir);
  let files = (await readdir(dir))
    .filter((f) => AUDIO.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(dir, f));
  if (args.limit) files = files.slice(0, Number(args.limit));
  if (files.length === 0) {
    process.stderr.write(`no audio files in ${dir}\n`);
    return 2;
  }
  process.stderr.write(`${files.length} files, ${jobs} at a time, mark at ${options.strength} dB, key ${options.key}\n`);

  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next];
        next += 1;
        const result = await runOne(file, options);
        process.stderr.write(`  ${result.error ? 'FAILED' : 'done  '} ${basename(file)}${result.error ? `: ${result.error}` : ''}\n`);
        results.push(result);
      }
    }),
  );
  results.sort((a, b) => a.file.localeCompare(b.file));

  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  // attack name -> { read, total, lost: [names] }, in the order the harness lists them.
  const table = new Map();
  let falsePositives = 0;
  let unmarkedChecked = 0;
  for (const result of ok) {
    for (const row of result.rows) {
      if (row.unmarked) {
        unmarkedChecked += 1;
        if (row.falsePositive) falsePositives += 1;
        continue;
      }
      if (row.skipped) continue;
      const entry = table.get(row.attack) ?? { read: 0, total: 0, lost: [] };
      entry.total += 1;
      if (row.decoded) entry.read += 1;
      else entry.lost.push(basename(result.file, extname(result.file)));
      table.set(row.attack, entry);
    }
  }

  const lines = [];
  lines.push(`Corpus: ${ok.length} files from ${dir}, mark at ${options.strength} dB, key ${options.key}.`);
  if (failed.length) lines.push(`${failed.length} file(s) could not be run: ${failed.map((r) => `${basename(r.file)} (${r.error})`).join('; ')}`);
  lines.push('');
  lines.push('| Attack | Read | Tracks it was lost on |');
  lines.push('|---|---|---|');
  for (const [name, e] of table) {
    const pct = ((100 * e.read) / e.total).toFixed(0);
    lines.push(`| ${name} | ${e.read} of ${e.total} (${pct}%) | ${e.lost.length ? e.lost.join(', ') : ''} |`);
  }
  lines.push('');
  // The rule of three: no events in n trials puts the true rate under 3/n with 95% confidence.
  const bound = unmarkedChecked > 0 && falsePositives === 0 ? ` With none in ${unmarkedChecked}, the rate is under ${(300 / unmarkedChecked).toFixed(1)}% at 95% confidence.` : '';
  lines.push(`Unmarked tracks reported as marked: ${falsePositives} of ${unmarkedChecked}.${bound}`);
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (args.out) await writeFile(args.out, text);
  return falsePositives > 0 || failed.length === files.length ? 3 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exit(1);
    });
}
