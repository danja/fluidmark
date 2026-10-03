// src/audio-node.js
//
// Reading an audio file in Node: WAV directly, anything else through ffmpeg.
//
// Node side only, because it shells out. The page has its own reader (`audio-browser.js`) that
// uses the browser's decoder, and the two share what they can, `wav.js`, and nothing else.
//
// ffmpeg is asked for 32-bit float WAV at the file's own sample rate and channel count, so
// nothing is resampled, folded or quantised on the way in: what the marker sees is what the
// decoder produced.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { decodeWavChannels } from './wav.js';

function isWav(bytes) {
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

/**
 * Read a file into channels.
 *
 * @returns {Promise<ReturnType<typeof decodeWavChannels> & {kind: 'wav' | 'ffmpeg'}>}
 */
export async function readAudioFile(path) {
  const bytes = new Uint8Array(await readFile(path));
  if (isWav(bytes)) {
    return { ...decodeWavChannels(bytes), kind: 'wav' };
  }
  let decoded;
  try {
    decoded = execFileSync(
      'ffmpeg',
      ['-loglevel', 'error', '-i', path, '-vn', '-f', 'wav', '-acodec', 'pcm_f32le', 'pipe:1'],
      { maxBuffer: 2 * 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`${path} is not a WAV, and ffmpeg is needed to read anything else but is not installed`);
    }
    const detail = error.stderr ? String(error.stderr).trim().split('\n').pop() : error.message;
    throw new Error(`ffmpeg could not read ${path}: ${detail}`);
  }
  return { ...decodeWavChannels(new Uint8Array(decoded)), kind: 'ffmpeg' };
}
