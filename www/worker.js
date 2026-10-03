// www/worker.js
//
// Where the work happens: decoding a file, marking it, looking for a mark. A dedicated worker, so a long file
// does not freeze the page, the page can show what stage it is at, and Cancel can be honest: a call into Wasm
// cannot be interrupted from inside, but the worker running it can be terminated, which is a cancel.
//
// The page sends one message per job and gets status messages and then either a result or an error. Nothing
// here touches the DOM. The import graph is relative to this file, so it stays under the path the site is
// served at (`tests/web.test.js` walks it).

import { loadCore } from './src/load-browser.js';
import { readAudioFile } from './src/audio-browser.js';
import { mark as markTones, read as readTones, TONE_RATE } from './src/mark.js';
import { encodeWav, encodeWavChannels, outputBitsFor } from './src/wav.js';
import * as spread from './src/spread.js';

let core = null;

async function getCore() {
  core ??= await loadCore();
  return core;
}

const status = (text) => postMessage({ type: 'status', text });

/** Minutes and seconds, for a length a person will compare against their track. */
function clock(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Channels averaged into one, for the tone reader, which is mono by definition. */
function fold(channelData) {
  if (channelData.length === 1) return channelData[0];
  const out = new Float32Array(channelData[0].length);
  for (const channel of channelData) {
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / channelData.length;
  }
  return out;
}

async function mark({ file, payload, scheme, keyText }) {
  const codec = await getCore();
  if (scheme === 'tones') {
    const samples = markTones(codec, payload);
    const wavBytes = encodeWav(samples, TONE_RATE).buffer;
    return {
      result: {
        wavBytes,
        name: 'marked-tones.wav',
        detail: `${TONE_RATE} Hz mono, ${clock(samples.length / TONE_RATE)}. Audible tones, the original scheme. This is a new file of beeps, not your music.`,
      },
      transfer: [wavBytes],
    };
  }

  status(`Reading ${file.name}…`);
  const audio = await readAudioFile(file);

  const bytes = new TextEncoder().encode(payload);
  const needed = spread.minSamples(codec, bytes.length, audio.sampleRate);
  if (audio.frames < needed) {
    throw new Error(
      `this track is ${clock(audio.frames / audio.sampleRate)} long and a mark with an identifier this long ` +
        `needs at least ${clock(needed / audio.sampleRate)}. A shorter identifier needs less.`,
    );
  }

  status(`Marking ${plural(audio.channels, 'channel')} of ${clock(audio.frames / audio.sampleRate)}…`);
  const key = spread.keyFromText(keyText);
  const marked = spread.embed(codec, audio.channelData, bytes, { key, sampleRate: audio.sampleRate });

  status('Writing the file…');
  // A WAV keeps its own depth, so marking a 24-bit master does not cut it to 16. An MP3 has no depth to keep
  // and is written 16-bit.
  const bits = audio.kind === 'wav' ? outputBitsFor(audio) : 16;
  const wavBytes = encodeWavChannels(marked, audio.sampleRate, { bits }).buffer;
  const copies = Math.floor(audio.frames / needed);
  const detail =
    `${audio.sampleRate} Hz, ${plural(audio.channels, 'channel')}, ${clock(audio.frames / audio.sampleRate)}. ` +
    `${plural(copies, 'copy')} of the mark${copies > 1 ? ', which is what lets it survive damage' : ''}. ` +
    `${keyText.trim() ? 'Made with your key.' : 'Made with the public default key, so anyone can read it.'} ` +
    `Written as a ${bits === 32 ? '32-bit float' : `${bits}-bit`} WAV${audio.kind === 'mp3' ? ' (an MP3 has no bit depth of its own)' : ''}.`;
  return {
    result: { wavBytes, name: `${file.name.replace(/\.[^.]+$/, '')}-marked.wav`, detail },
    transfer: [wavBytes],
  };
}

async function read({ file, keyText }) {
  const codec = await getCore();
  status(`Reading ${file.name}…`);
  const audio = await readAudioFile(file);
  const shape = `${audio.sampleRate} Hz, ${plural(audio.channels, 'channel')}, ${clock(audio.frames / audio.sampleRate)}`;

  // Three outcomes, three elements on the page. Collapsing them into one box is how "no mark" turns into "an empty
  // identifier" and users conclude the tool is broken. The watermark is looked for first, then the tones, and a
  // damaged find from either is kept in case the other finds nothing.
  status(`Looking for the watermark in ${clock(audio.frames / audio.sampleRate)} of audio…`);
  const key = spread.keyFromText(keyText);
  const w = spread.detect(codec, audio.channelData, { key, sampleRate: audio.sampleRate });
  if (w.ok) {
    const text = new TextDecoder().decode(w.payload);
    // A file played slower or faster than it was marked is read by correcting for it, and a person who is told it
    // was is better placed than one who thinks it was untouched.
    const drift = (w.speed - 1) * 100;
    const speedNote = Math.abs(drift) >= 0.0001
      ? ` The file runs ${Math.abs(drift).toPrecision(2)}% ${drift > 0 ? 'slower' : 'faster'} than it was marked, and was corrected for.`
      : '';
    return { result: { outcome: 'found', text, detail: `Found by the watermark reader. ${shape}. The checksum matched.${speedNote}` } };
  }
  let damaged = w.reason === 'damaged';

  // The tone reader works at one rate only, so a file at another rate is not read by it, and the page says so
  // instead of reporting a mark that is merely out of range.
  let tonesSkipped = false;
  if (audio.sampleRate === TONE_RATE) {
    status('Looking for the original tones…');
    const t = readTones(codec, fold(audio.channelData));
    if (t.ok) return { result: { outcome: 'found', text: t.text, detail: `Found by the tone reader. ${shape}. The checksum matched.` } };
    damaged = damaged || t.reason !== 'no-mark';
  } else {
    tonesSkipped = true;
  }

  if (damaged) {
    return {
      result: {
        outcome: 'damaged',
        damaged:
          'Something was found but it does not check out, so it is not reported as an identifier. ' +
          'The file may have been processed or truncated.',
        detail: shape,
      },
    };
  }
  return {
    result: {
      outcome: 'none',
      none:
        'No mark found in this file. That is a definite answer, not a failure. If the mark was made with a key, ' +
        'this is also what a wrong or missing key looks like.',
      detail: `${shape}.${tonesSkipped ? ` The tone reader only reads ${TONE_RATE} Hz files, so it was not tried.` : ''}`,
    },
  };
}

const jobs = { mark, read };

self.onmessage = async (event) => {
  const { op, ...params } = event.data;
  try {
    if (!jobs[op]) throw new Error(`unknown job "${op}"`);
    status('Loading the codec…');
    const { result, transfer = [] } = await jobs[op](params);
    postMessage({ type: 'result', result }, transfer);
  } catch (error) {
    postMessage({ type: 'error', message: error.message ?? String(error) });
  }
};
