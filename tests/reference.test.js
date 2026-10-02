// tests/reference.test.js
//
// Reading the reference implementation's own output.
//
// This is the test that decides whether the port is a port. Everything else checks a piece
// against a specification written from the reference's source; this checks the port against
// files the reference actually produced, with payloads nobody here chose.
//
// The one that matters is `reference/WebBeep/data/beeps.wav`: the reference's own `CodecTest`
// encodes the string "abc" into it, so reading back "abc" is cross-implementation agreement
// rather than a round trip through our own encoder. The `www/audio` files are what the live
// service returned to users, and their filenames are their payloads.
//
// Skipped, not passed, when the reference or ffmpeg is absent: `reference/` is reference
// material rather than part of the repository, and the MP3s need an external decoder. The skip
// is declared on the describe blocks so a skipped run is reported as skipped, which an early
// return inside the test body would not do.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCore } from '../src/load-node.js';
import { read as readMark } from '../src/mark.js';
import { decodeWav } from '../src/wav.js';

const REFERENCE = fileURLToPath(new URL('../reference/WebBeep/', import.meta.url));
const haveReference = existsSync(`${REFERENCE}data/beeps.wav`);

function haveFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const haveDecoder = haveFfmpeg();

/** Decode an MP3 to samples using ffmpeg. Needs an external binary, hence the skip. */
function mp3ToSamples(file) {
  const wav = execFileSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', file, '-ar', '22050', '-ac', '1', '-sample_fmt', 's16', '-f', 'wav', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return decodeWav(new Uint8Array(wav)).samples;
}

let core = null;

afterEach(() => {
  if (core) {
    core.destroy();
    core = null;
  }
});

describe.skipIf(!haveReference)("the reference implementation's own output", () => {
  it('reads the string the reference encoded into beeps.wav', async () => {
    core = await loadCore();
    const wav = decodeWav(new Uint8Array(readFileSync(`${REFERENCE}data/beeps.wav`)));
    const result = readMark(core, wav.samples);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('abc');
  });

  it('reports nothing for the reference material that holds no mark', async () => {
    core = await loadCore();
    // testin.wav, noisy.wav, reverby.wav and 3db-clipping.wav are interference test material,
    // not marked audio. A detector that found a payload in one of these would be a false
    // positive, which is the worst failure this project has.
    for (const name of ['testin.wav', 'noisy.wav', 'reverby.wav', '3db-clipping.wav']) {
      const wav = decodeWav(new Uint8Array(readFileSync(`${REFERENCE}data/${name}`)));
      const result = readMark(core, wav.samples);
      expect(result.ok, `${name} should hold no mark`).toBe(false);
      expect(result.reason).toBe('no-mark');
    }
  });
});

describe.skipIf(!haveReference || !haveDecoder)('the payloads the live service produced', () => {
  const cases = [
    { file: 'qwe.mp3', text: 'qwe' },
    { file: 'dfgdfg.mp3', text: 'dfgdfg' },
    { file: 'sdfsdfs.mp3', text: 'sdfsdfs' },
    { file: 'Qwerf.mp3', text: 'Qwerf' },
    { file: 'ISP_loveSP_you!.mp3', text: 'I love you!' },
  ].filter(({ file }) => existsSync(`${REFERENCE}www/audio/${file}`));

  it.each(cases)('recovers $text from $file', async ({ file, text }) => {
    core = await loadCore();
    const result = readMark(core, mp3ToSamples(`${REFERENCE}www/audio/${file}`));
    expect(result.ok, `${file} reported ${result.reason}`).toBe(true);
    expect(result.text).toBe(text);
  });

  it.skipIf(!existsSync(`${REFERENCE}www/audio/Example.mp3`))(
    'reports a longer payload as damaged rather than as an answer',
    async () => {
      // Example.mp3 is the one file in the service's own audio directory this port does not
      // recover: it decodes to twenty printable but wrong bytes, and the checksum catches that.
      // Recorded as a test so the failure stays visible instead of being discovered later, and
      // because the behaviour that matters here is the refusal, not the recovery.
      core = await loadCore();
      const result = readMark(core, mp3ToSamples(`${REFERENCE}www/audio/Example.mp3`));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('checksum');
    },
  );
});