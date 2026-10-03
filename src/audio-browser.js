// src/audio-browser.js
//
// Reading an audio file the user chose, in the browser: WAV by the code in `wav.js`, MP3 by the
// browser's own decoder through WebCodecs. Browser side only, because `AudioDecoder` does not
// exist anywhere else; the Node tools read WAV and leave MP3 to ffmpeg.
//
// Channels stay separate and the file's own sample rate is kept. Folding to mono or resampling are
// decisions for the caller, and a page that did either here would be altering a track before
// marking it.

import { splitFrames } from './mp3.js';
import { decodeWavChannels } from './wav.js';

/** Most bytes read from one file. Past this the page would be holding several copies of it. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

function isWav(bytes) {
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

function looksLikeMp3(bytes) {
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  return id3 || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
}

/**
 * Read a file into channels.
 *
 * @returns {Promise<{channelData: Float32Array[], sampleRate: number, channels: number,
 *   frames: number, bitsPerSample: number | null, kind: 'wav' | 'mp3'}>}
 */
export async function readAudioFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB, more than this page will hold`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (isWav(bytes)) {
    return { ...decodeWavChannels(bytes), kind: 'wav' };
  }
  if (looksLikeMp3(bytes)) {
    return { ...(await decodeMp3(bytes)), bitsPerSample: null, kind: 'mp3' };
  }
  throw new Error(
    `${file.name} is not a WAV or an MP3. This page reads those two; FLAC, OGG and M4A would need a decoder it does not have.`,
  );
}

/** An MP3 through `AudioDecoder`, one frame at a time. */
async function decodeMp3(bytes) {
  if (typeof AudioDecoder === 'undefined') {
    throw new Error('this browser cannot decode MP3 and there is no fallback here. A WAV file will work.');
  }
  const found = splitFrames(bytes);
  if (found.frames.length === 0) {
    throw new Error('no MP3 audio frames found: the file may be damaged, or not MP3 after all');
  }
  const { sampleRate, channels, samplesPerFrame } = found;

  const config = { codec: 'mp3', sampleRate, numberOfChannels: channels };
  const support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`this browser cannot decode MP3 at ${sampleRate} Hz with ${channels} channel${channels === 1 ? '' : 's'}`);
  }

  // Each decoded block is copied out per channel straight away, because an AudioData is closed as
  // soon as it is done with and reading it afterwards reads nothing.
  const blocks = Array.from({ length: channels }, () => []);
  let failure = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        for (let c = 0; c < channels; c += 1) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          blocks[c].push(plane);
        }
      } catch (error) {
        failure = failure ?? error;
      } finally {
        data.close();
      }
    },
    error: (error) => {
      failure = failure ?? error;
    },
  });
  decoder.configure(config);

  const frameMicros = (samplesPerFrame / sampleRate) * 1e6;
  for (let i = 0; i < found.frames.length && failure === null; i += 1) {
    const { start, end } = found.frames[i];
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * frameMicros), data: bytes.subarray(start, end) }));
    // Do not queue the whole file at once: that is memory for nothing, and a decoder that has
    // already failed would be fed the rest.
    if (decoder.decodeQueueSize > 64) {
      await new Promise((resolve) => decoder.addEventListener('dequeue', resolve, { once: true }));
    }
  }
  await decoder.flush().catch((error) => {
    failure = failure ?? error;
  });
  decoder.close();
  if (failure) throw new Error(`the browser could not decode this MP3: ${failure.message ?? failure}`);

  const channelData = blocks.map((chunks) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  });
  const frames = channelData[0]?.length ?? 0;
  if (frames === 0) throw new Error('the browser decoded this MP3 to nothing');
  return { channelData, sampleRate, channels, frames };
}
