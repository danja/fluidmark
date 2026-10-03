// tests/audio-node.test.js
//
// Reading files in the Node tools. WAV needs nothing; everything else needs ffmpeg, and those
// tests are skipped, and reported as skipped, when it is not installed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readAudioFile } from '../src/audio-node.js';
import { synthTrack } from '../src/synth.js';
import { encodeWavChannels } from '../src/wav.js';

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = hasFfmpeg();

const dir = mkdtempSync(join(tmpdir(), 'fluidmark-audio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readAudioFile', () => {
  it('reads a WAV directly, with its channels and rate', async () => {
    const path = join(dir, 'a.wav');
    writeFileSync(path, encodeWavChannels([synthTrack(1, 32000, 1), synthTrack(1, 32000, 2)], 32000));
    const audio = await readAudioFile(path);
    expect(audio).toMatchObject({ kind: 'wav', channels: 2, sampleRate: 32000, frames: 32000 });
  });

  it('refuses a file that is not there, and one that is not audio', async () => {
    await expect(readAudioFile(join(dir, 'missing.wav'))).rejects.toThrow();
    const junk = join(dir, 'junk.bin');
    writeFileSync(junk, Buffer.from('this is not audio at all'));
    await expect(readAudioFile(junk)).rejects.toThrow(FFMPEG ? /ffmpeg could not read/ : /ffmpeg is needed/);
  });
});

describe.skipIf(!FFMPEG)('through ffmpeg (skipped without it)', () => {
  it('reads a stereo MP3 at its own rate, with the channels kept', async () => {
    const wav = join(dir, 'b.wav');
    const mp3 = join(dir, 'b.mp3');
    writeFileSync(wav, encodeWavChannels([synthTrack(3, 44100, 3), synthTrack(3, 44100, 4)], 44100));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-b:a', '128k', mp3]);
    const audio = await readAudioFile(mp3);
    expect(audio).toMatchObject({ kind: 'ffmpeg', channels: 2, sampleRate: 44100 });
    // Within the codec's padding of three seconds.
    expect(Math.abs(audio.frames - 3 * 44100)).toBeLessThan(4000);
    expect(audio.channelData[0].some((v) => v !== 0)).toBe(true);
  });

  it('reads a mono file at another rate without resampling it', async () => {
    const wav = join(dir, 'c.wav');
    const flac = join(dir, 'c.flac');
    writeFileSync(wav, encodeWavChannels([synthTrack(2, 22050, 5)], 22050));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, flac]);
    const audio = await readAudioFile(flac);
    expect(audio).toMatchObject({ kind: 'ffmpeg', channels: 1, sampleRate: 22050, frames: 44100 });
  });
});
