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
import { ATTACK_LIST, ATTACKS, EXTRA_LIST, REMOVAL_LIST, REMOVAL_SPREAD_LIST } from '../src/attacks.js';
import { bitErrors, frame, unframe } from '../src/frame.js';
import { decodeWavChannels, encodeWavChannels } from '../src/wav.js';
import * as spread from '../src/spread.js';
import { DEFAULT_MASKED_MARGIN_DB, DEFAULT_STRENGTH_DB, detectRaw } from '../src/spread.js';
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

/** A lossy round trip through ffmpeg that keeps the channel count, or null without ffmpeg. */
function lossyRoundTrip(wavBytes, sampleRate, channels, bitrate) {
  try {
    const mp3 = execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'],
      { input: wavBytes, maxBuffer: 512 * 1024 * 1024 },
    );
    const back = execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-i', 'pipe:0', '-ar', String(sampleRate), '-ac', String(channels),
       '-sample_fmt', 's16', '-f', 'wav', 'pipe:1'],
      { input: mp3, maxBuffer: 512 * 1024 * 1024 },
    );
    return decodeWavChannels(new Uint8Array(back)).channelData;
  } catch {
    return null;
  }
}

/** Channels averaged into one. */
function fold(channelData) {
  const out = new Float32Array(channelData[0].length);
  for (const channel of channelData) {
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / channelData.length;
  }
  return out;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args.in || !args.payload) {
    process.stderr.write(
      'usage: node bin/attack.js --in track.wav --payload "text" [--scheme lsb|spread] [--strength dB] [--level relative|masked] [--json] [--out marked.wav]\n',
    );
    return 2;
  }
  const key = args.key ? BigInt(args.key) : DEFAULT_KEY;
  const scheme = args.scheme ?? 'lsb';
  if (scheme !== 'lsb' && scheme !== 'spread') {
    process.stderr.write(`unknown scheme "${scheme}": lsb or spread\n`);
    return 2;
  }
  const level = args.level ?? 'relative';
  if (level !== 'relative' && level !== 'masked') {
    process.stderr.write(`unknown level "${level}": relative or masked\n`);
    return 2;
  }
  const strengthDb = args.strength === undefined ? (level === 'masked' ? DEFAULT_MASKED_MARGIN_DB : DEFAULT_STRENGTH_DB) : Number(args.strength);

  const wav = decodeWavChannels(new Uint8Array(await readFile(args.in)));
  const audio = wav.channelData;
  const channels = wav.channels;
  if (scheme === 'lsb' && channels > 1) {
    process.stderr.write('the LSB baseline is mono: give it a mono file, or use --scheme spread\n');
    return 2;
  }
  const payload = new TextEncoder().encode(String(args.payload));
  const framed = frame(payload);
  const bits = framed.length * 8;
  const { lo, hi } = splitKey(key);

  const core = await loadCore();
  try {
    // The control row is the unattacked file, and for the spread scheme the mark needs a track
    // long enough to hold a copy. Say so before embedding rather than from deep inside it.
    if (scheme === 'spread') {
      const needed = core.ssMinSamples(framed.length, wav.sampleRate);
      if (wav.frames < needed) {
        process.stderr.write(
          `the track is ${wav.frames} samples per channel and one copy of the mark needs ${needed} ` +
            `(${(needed / wav.sampleRate).toFixed(1)} s at ${wav.sampleRate} Hz)\n`,
        );
        return 2;
      }
    }
    // Always an array of channels, so every row below treats mono and stereo the same way.
    const marked = scheme === 'spread'
      ? spread.embed(core, audio, payload, { key, sampleRate: wav.sampleRate, strengthDb, level })
      : [core.embedLsb(audio[0], framed, { lo, hi })];

    if (args.out) {
      await writeFile(args.out, encodeWavChannels(marked, wav.sampleRate));
    }

    /** One attack over every channel. Noise gets a different seed per channel: the same noise in
     *  both would add coherently in a fold to mono, which is not what independent noise does. */
    const attackAll = (id, param, seed, input = marked) =>
      input.map((channel, i) => core.attack(id, param, wav.sampleRate, channel, seed + i));

    const rows = [];
    const add = (name, samples, note = '', rate = wav.sampleRate) => {
      if (scheme === 'spread') {
        const found = detectRaw(core, samples, { key, sampleRate: rate });
        const seen = found.status !== 'none';
        // No sync found means there is nothing to compare, and reporting 100% (nothing read) or
        // 50% (a guess) would both be inventing a figure. It is reported as not found.
        const errors = seen ? bitErrors(framed, found.frame) : null;
        // A frame that verifies but is not the one that went in is a different mark that checks out,
        // which is not a survival: it is what averaging two differently-marked copies produces.
        const verified = found.status === 'verified';
        const same = verified && errors === 0;
        rows.push({
          attack: name,
          bitErrors: errors,
          bits,
          ber: seen ? errors / bits : null,
          decoded: same,
          reason: same ? 'ok' : verified ? 'a different payload, which checks out' : found.status === 'damaged' ? 'damaged' : 'no mark found',
          confidence: found.confidence,
          note,
        });
        return;
      }
      const raw = core.extractLsb(samples[0], framed.length, { lo, hi });
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

    // The controls first, so every other row has something to be compared against in the output:
    // the marked file untouched, which must read, and the unmarked file, which must not. A harness
    // with only the first would pass a detector that reports a mark in everything.
    add('none (control)', marked);
    const unmarked = scheme === 'spread'
      ? detectRaw(core, audio, { key, sampleRate: wav.sampleRate }).status === 'verified'
      : unframe(core.extractLsb(audio[0], framed.length, { lo, hi })).ok;
    rows.push({
      attack: 'unmarked track (control)',
      unmarked: true,
      falsePositive: unmarked,
      decoded: false,
      reason: unmarked ? 'FALSE POSITIVE' : 'no mark found, as it should',
    });
    for (const row of ATTACK_LIST) {
      // A resample changes the rate of what comes out, and the reader is told the rate it has.
      const rate = row.id === ATTACKS.RESAMPLE ? wav.sampleRate * row.param : wav.sampleRate;
      add(row.name, attackAll(row.id, row.param, row.seed ?? 0), row.note ?? '', rate);
    }

    // Beyond the brief, labelled as such. A speed change is read at the rate the file claims, which
    // is the rate it was marked at, because that is what a file played faster still says.
    if (scheme === 'spread') {
      for (const row of EXTRA_LIST) {
        add(row.name, attackAll(row.id, row.param, row.seed ?? 0), 'beyond the brief');
      }
    }

    // What stereo material goes through that mono material does not: a fold to mono, and one channel
    // being all that is kept. The mark is the same stream in every channel, so both should read.
    if (channels > 1 && scheme === 'spread') {
      add('stereo to mono (fold)', [fold(marked)], 'the brief names it');
      add('one channel only', [marked[0]], 'left channel kept');
    }

    // Removal, after the degradation rows and labelled as its own thing, because "how do I get
    // rid of this" and "what does processing do to this" are different questions and a table that
    // mixed them would answer neither.
    // The two removals here are low-bit scrubs, which are aimed at the LSB control and say nothing
    // about a spread-spectrum mark, so they run for LSB only. A removal attack for the spread scheme
    // is its own piece of work (TODO.md), and a row that always reads "survived" would be a figure
    // that was not measuring what it appears to.
    for (const row of scheme === 'lsb' ? REMOVAL_LIST : []) {
      add(row.name, attackAll(row.id, row.param, row.seed ?? 0), 'needs no key');
    }
    // For the spread scheme: a removal that needs no key, reported with what it cost the music, since
    // a removal that wrecks the track is not an attack, and one that costs nothing audible is.
    if (scheme === 'spread') {
      for (const row of REMOVAL_SPREAD_LIST) {
        const attacked = attackAll(row.id, row.param, row.seed ?? 0);
        let signal = 0;
        let noise = 0;
        attacked.forEach((channel, c) => {
          for (let i = 0; i < channel.length; i += 1) {
            signal += marked[c][i] ** 2;
            noise += (marked[c][i] - channel[i]) ** 2;
          }
        });
        const snr = 10 * Math.log10(signal / Math.max(noise, 1e-30));
        add(row.name, attacked, `needs no key; the file moved ${snr.toFixed(1)} dB below itself`);
      }
    }

    // The lossy rows need an external binary, so they are reported separately whether or not it
    // is there, per AGENTS.md on environment-dependent tests.
    const haveFfmpeg = hasBinary('ffmpeg');
    if (haveFfmpeg) {
      const markedWav = encodeWavChannels(marked, wav.sampleRate);
      for (const bitrate of scheme === 'spread' ? ['128k', '64k', '48k', '32k'] : ['128k', '64k']) {
        const samples = lossyRoundTrip(markedWav, wav.sampleRate, channels, bitrate);
        const note = ['48k', '32k'].includes(bitrate) ? 'needs ffmpeg, beyond the brief' : 'needs ffmpeg';
        if (samples) add(`mp3 ${bitrate}`, samples, note);
        else rows.push({ attack: `mp3 ${bitrate}`, skipped: true, note: 'ffmpeg failed' });
      }
    } else {
      for (const bitrate of ['128k', '64k']) {
        rows.push({ attack: `mp3 ${bitrate}`, skipped: true, note: 'ffmpeg not installed' });
      }
    }

    // Collusion: someone with two copies of the track averages them. With the same key and another
    // payload the carriers agree and the bits partly cancel; with another key each mark is halved.
    // With a copy of the original they can subtract it and have the mark itself, which no scheme
    // that is read without the original can prevent, so that one is stated rather than measured.
    if (scheme === 'spread') {
      const other = (otherKey, otherPayload) =>
        spread.embed(core, audio, new TextEncoder().encode(otherPayload), { key: otherKey, sampleRate: wav.sampleRate, strengthDb, level });
      const average = (a, b) => a.map((channel, c) => channel.map((v, i) => (v + b[c][i]) / 2));
      add('collusion: average with a copy marked differently (same key)', average(marked, other(key, 'urn:other:copy-2')), 'beyond the brief');
      add('collusion: average with a copy under another key', average(marked, other(key ^ 0xffffn, String(args.payload))), 'beyond the brief');
    }

    const ran = rows.filter((r) => !r.skipped && !r.unmarked);
    const survived = ran.filter((r) => r.decoded);
    const falsePositive = rows.some((r) => r.falsePositive);

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ key: key.toString(), channels, sampleRate: wav.sampleRate, payloadBytes: payload.length, rows }, null, 2)}\n`);
    } else {
      printTable(rows, framed.length, bits, wav.sampleRate, channels, scheme, strengthDb, level);
      process.stdout.write(
        `\n${survived.length}/${ran.length} attacks left the payload readable` +
          ` (control included)\n`,
      );
    }
    // A false positive is the worst result this tool can print, so it is also the exit status.
    return falsePositive ? 3 : 0;
  } finally {
    core.destroy();
  }
}

function printTable(rows, frameBytes, bits, sampleRate, channels, scheme, strengthDb, level) {
  const width = Math.max(...rows.map((r) => r.attack.length), 22);
  process.stdout.write(
    `${scheme === 'spread' ? `Spread spectrum at ${strengthDb} dB ${level === 'masked' ? 'under the masking threshold' : 'relative to the music'}` : 'LSB baseline'}: ` +
      `${frameBytes} byte frame, ${bits} bits, ${sampleRate} Hz ${channels === 1 ? 'mono' : `${channels} channels`}\n\n`,
  );
  process.stdout.write(`${'attack'.padEnd(width)}   BER    recovered  note\n`);
  process.stdout.write(`${'-'.repeat(width)}  ------  ---------  ----\n`);
  for (const row of rows) {
    if (row.unmarked) {
      process.stdout.write(
        `${row.attack.padEnd(width)}  ------  ${row.falsePositive ? '!!' : 'ok'}         ${row.reason}\n`,
      );
      continue;
    }
    if (row.skipped) {
      process.stdout.write(
        `${row.attack.padEnd(width)}  ------  ---------  skipped: ${row.note}\n`,
      );
      continue;
    }
    const recovered = row.decoded ? 'yes' : `no (${row.reason})`;
    process.stdout.write(
      `${row.attack.padEnd(width)}  ${(row.ber === null ? 'n/a' : `${(row.ber * 100).toFixed(1)}%`).padStart(5)}   ${recovered.padEnd(9)}  ${row.note}\n`,
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