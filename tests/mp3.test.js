// tests/mp3.test.js
//
// Finding MP3 frames, against real files. The ones the old tone service wrote are MPEG-2 at
// 22.05 kHz mono with a Xing frame at the front, which is exactly what the page's first parser
// rejected, so they are the first cases. Stereo MPEG-1 files are made with ffmpeg when it is
// there; those tests are skipped, and reported as skipped, when it is not.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readHeader, splitFrames } from '../src/mp3.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/', import.meta.url));
const AUDIO = fileURLToPath(new URL('../reference/WebBeep/www/audio/', import.meta.url));

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = hasFfmpeg();

/** A tone through ffmpeg to an MP3, in the shape asked for. */
function encode({ rate, channels, bitrate = '128k', seconds = 3 }) {
  return new Uint8Array(
    execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=${rate}`,
       '-ac', String(channels), '-b:a', bitrate, '-f', 'mp3', 'pipe:1'],
      { maxBuffer: 64 * 1024 * 1024 },
    ),
  );
}

// The reference is local material (gitignored), so on a clean checkout, CI included, these report skipped.
const haveAudio = existsSync(AUDIO);

describe.skipIf(!haveAudio)('the files the old service wrote', () => {
  const files = haveAudio ? readdirSync(AUDIO).filter((f) => f.endsWith('.mp3')) : [];

  it('has files to test against', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('reads every one as MPEG-2, 22.05 kHz, mono, with frames', () => {
    for (const file of files) {
      const found = splitFrames(new Uint8Array(readFileSync(`${AUDIO}${file}`)));
      expect(found.sampleRate, file).toBe(22050);
      expect(found.channels, file).toBe(1);
      expect(found.samplesPerFrame, file).toBe(576);
      expect(found.frames.length, file).toBeGreaterThan(10);
    }
  });

  it('skips the Xing frame, which carries no audio', () => {
    const bytes = new Uint8Array(readFileSync(`${AUDIO}dfgdfg.mp3`));
    const found = splitFrames(bytes);
    expect(found.frames[0].start).toBeGreaterThan(0);
    expect(bytes[found.frames[0].start]).toBe(0xff);
  });

  it('has frames that tile the file without gaps or overlap', () => {
    const found = splitFrames(new Uint8Array(readFileSync(`${AUDIO}dfgdfg.mp3`)));
    for (let i = 1; i < found.frames.length; i += 1) {
      expect(found.frames[i].start).toBe(found.frames[i - 1].end);
    }
  });
});

describe('headers', () => {
  it('reads MPEG-1 Layer III stereo at 44.1 kHz', () => {
    // 0xFFFB, 128 kbps, 44.1 kHz, no padding, joint stereo.
    const h = readHeader(Uint8Array.of(0xff, 0xfb, 0x90, 0x44), 0);
    expect(h).toMatchObject({ version: 'mpeg1', sampleRate: 44100, channels: 2, bitrate: 128000, samplesPerFrame: 1152 });
    expect(h.length).toBe(417);
  });

  it('reads MPEG-2 and MPEG-2.5', () => {
    expect(readHeader(Uint8Array.of(0xff, 0xf3, 0x80, 0xc4), 0)).toMatchObject({ version: 'mpeg2', sampleRate: 22050, channels: 1 });
    expect(readHeader(Uint8Array.of(0xff, 0xe3, 0x80, 0xc4), 0)).toMatchObject({ version: 'mpeg25', sampleRate: 11025 });
  });

  it('refuses what is not a Layer III header', () => {
    expect(readHeader(Uint8Array.of(0x00, 0xfb, 0x90, 0x44), 0)).toBeNull(); // no sync
    expect(readHeader(Uint8Array.of(0xff, 0xfd, 0x90, 0x44), 0)).toBeNull(); // Layer II
    expect(readHeader(Uint8Array.of(0xff, 0xeb, 0x90, 0x44), 0)).toBeNull(); // reserved version
    expect(readHeader(Uint8Array.of(0xff, 0xfb, 0x00, 0x44), 0)).toBeNull(); // free format
    expect(readHeader(Uint8Array.of(0xff, 0xfb, 0xf0, 0x44), 0)).toBeNull(); // bad bitrate
    expect(readHeader(Uint8Array.of(0xff, 0xfb, 0x9c, 0x44), 0)).toBeNull(); // bad sample rate
    expect(readHeader(Uint8Array.of(0xff, 0xfb), 0)).toBeNull(); // truncated
  });
});

describe('files that are not what they claim', () => {
  it('finds no frames in bytes that are not MP3', () => {
    expect(splitFrames(new Uint8Array(1000)).frames).toEqual([]);
    expect(splitFrames(new Uint8Array(0)).frames).toEqual([]);
    expect(splitFrames(Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919) & 0xff)).frames).toEqual([]);
  });

  it('does not take a stray 0xFF in tag data for a frame', () => {
    const good = new Uint8Array(readFileSync(`${FIXTURE}dfgdfg.mp3`));
    const junk = Uint8Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 0xff : 0xe0));
    const joined = new Uint8Array(junk.length + good.length);
    joined.set(junk);
    joined.set(good, junk.length);
    const found = splitFrames(joined);
    expect(found.sampleRate).toBe(22050);
    expect(found.frames.length).toBe(splitFrames(good).frames.length);
  });

  it('skips an ID3v2 tag', () => {
    const good = new Uint8Array(readFileSync(`${FIXTURE}dfgdfg.mp3`));
    const tag = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(0xff)]);
    const joined = new Uint8Array(tag.length + good.length);
    joined.set(tag);
    joined.set(good, tag.length);
    expect(splitFrames(joined).frames.length).toBe(splitFrames(good).frames.length);
  });
});

describe.skipIf(!FFMPEG)('files made by ffmpeg (skipped without it)', () => {
  it('reads stereo MPEG-1 at 44.1 kHz and 48 kHz', () => {
    for (const rate of [44100, 48000]) {
      const found = splitFrames(encode({ rate, channels: 2 }));
      expect(found.sampleRate).toBe(rate);
      expect(found.channels).toBe(2);
      expect(found.samplesPerFrame).toBe(1152);
      // About three seconds of frames, give or take the encoder's padding.
      expect(Math.abs(found.frames.length - (3 * rate) / 1152)).toBeLessThan(5);
    }
  });

  it('reads mono MPEG-1, and low-rate MPEG-2', () => {
    expect(splitFrames(encode({ rate: 44100, channels: 1 }))).toMatchObject({ channels: 1, sampleRate: 44100 });
    expect(splitFrames(encode({ rate: 22050, channels: 2, bitrate: '64k' }))).toMatchObject({ channels: 2, sampleRate: 22050, samplesPerFrame: 576 });
  });

  it('reads variable bitrate files, where the frame lengths differ', () => {
    const vbr = new Uint8Array(
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100', '-q:a', '4', '-f', 'mp3', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 }),
    );
    const found = splitFrames(vbr);
    expect(found.frames.length).toBeGreaterThan(100);
    for (let i = 1; i < found.frames.length; i += 1) {
      expect(found.frames[i].start).toBe(found.frames[i - 1].end);
    }
  });
});
