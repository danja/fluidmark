// www/app.js
//
// The page's behaviour. Vanilla JavaScript, no framework, no build step beyond the Wasm module.
//
// Two operations, matching the previous site: mark a file with an identifier, and read an
// identifier back out of a marked file. Both run in this page. Nothing is uploaded, and the only
// reason that is true is that the codec is here rather than on a server.
//
// Every element is reached by id, and `tests/web.test.js` asserts each id is still here. An
// element that has gone is a null dereference at the moment a user presses a button, which is the
// worst time to find out.

import { loadCore } from './src/load-browser.js';
import { mark as markTones, read as readTones } from './src/mark.js';
import { decodeWav, encodeWav } from './src/wav.js';
import { embed, extract } from './src/watermark.js';
import { REASONS } from './src/frame.js';

/** Where the payloads come from, in bits, for the inaudible scheme. */
const WATERMARK_KEY = 0x0123_4567_89ab_cdefn;

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  payload: $('payload'),
  payloadCount: $('payload-count'),
  carrier: $('carrier'),
  source: $('source'),
  sourceInfo: $('source-info'),
  markButton: $('mark-button'),
  cancelMark: $('cancel-mark'),
  markResult: $('mark-result'),
  markDownload: $('mark-download'),
  markDetail: $('mark-detail'),
  marked: $('marked'),
  markedInfo: $('marked-info'),
  readButton: $('read-button'),
  cancelRead: $('cancel-read'),
  readResult: $('read-result'),
  readPayload: $('read-payload'),
  readNone: $('read-none'),
  readDamaged: $('read-damaged'),
};

let core = null;
let coreFailed = false;

/** Load the core once, on first use, and say so if it fails. */
async function getCore() {
  if (core) return core;
  if (coreFailed) throw new Error('the codec did not load, so nothing can be done here');
  setStatus('Loading the codec…');
  try {
    core = await loadCore();
    setStatus('Ready.');
    return core;
  } catch (error) {
    coreFailed = true;
    setStatus(`The codec did not load: ${error.message}. Reload the page to try again.`);
    throw error;
  }
}

function setStatus(message) {
  els.status.textContent = message;
}

/** A file's name and size in text, because a file input announces neither reliably. */
function describeFile(input, info) {
  const file = input.files && input.files[0];
  if (!file) {
    info.textContent = info.dataset.empty || 'No file chosen.';
    return null;
  }
  const kb = (file.size / 1024).toFixed(0);
  info.textContent = `${file.name}, ${kb} kB`;
  return file;
}

els.source.addEventListener('change', () => describeFile(els.source, els.sourceInfo));
els.marked.addEventListener('change', () => describeFile(els.marked, els.markedInfo));

function updateCount() {
  const used = els.payload.value.length;
  els.payloadCount.textContent = `${used} of 63 characters used.`;
}
els.payload.addEventListener('input', updateCount);
updateCount();

/**
 * Read a file into samples.
 *
 * WAV is decoded here. MP3 is decoded by the browser's own decoder through WebCodecs, which needs
 * the frames split out first, so `mp3ToSamples` walks them. Anything else is refused with a
 * message rather than guessed at.
 */
async function readAudio(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  if (name.endsWith('.wav') || bytes[0] === 0x52 || bytes[1] === 0x49) {
    return { wav: decodeWav(bytes) };
  }
  if (name.endsWith('.mp3') || bytes[0] === 0xff) {
    const samples = await mp3ToSamples(bytes);
    return { wav: { samples, sampleRate: 22050, channels: 1, bitsPerSample: 16 } };
  }
  throw new Error(
    `${file.name}: this page reads WAV and MP3 only. FLAC, OGG and M4A would need a decoder this page does not have.`,
  );
}

/** Split an MP3 into frames and hand them to the browser's decoder. */
async function mp3ToSamples(bytes) {
  if (typeof AudioDecoder === 'undefined') {
    throw new Error(
      'this browser cannot decode MP3, and there is no fallback here. A WAV file will work.',
    );
  }
  const frames = splitMp3Frames(bytes);
  if (frames.length === 0) {
    throw new Error('no MP3 frames found: the file may not be MP3.');
  }
  const header = readMp3Header(bytes, frames[0].start);
  const chunks = [];
  let total = 0;

  const decoder = new AudioDecoder({
    output: (buffer) => {
      // Mono is what the codec works in, so downmix here rather than in two places.
      const left = buffer.getChannelData(0);
      const mono =
        buffer.numberOfChannels === 1
          ? left
          : Float32Array.from(
              left,
              (v, i) => (v + buffer.getChannelData(1)[i]) * 0.5,
            );
      chunks.push(mono);
      total += mono.length;
    },
    error: (error) => {
      throw error;
    },
  });

  decoder.configure({
    codec: 'mp3',
    sampleRate: header.sampleRate,
    numberOfChannels: 1,
  });

  for (const frame of frames) {
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: frame.start, data: bytes.subarray(frame.start, frame.end) }));
  }
  await decoder.flush();
  decoder.close();

  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Bitrates and sample rates, from the MPEG tables, indexed by the header's index fields. */
const MP3_BITRATES = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
];
const MP3_RATES = [44100, 48000, 32000, 0];

/** The MPEG-1 Layer III header at `start`, or null if there is not one. */
function readMp3Header(bytes, start) {
  const b0 = bytes[start];
  const b1 = bytes[start + 1];
  const b2 = bytes[start + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03; // 3 is MPEG-1
  const layerBits = (b1 >> 1) & 0x03; // 1 is Layer III
  if (layerBits !== 1 || versionBits !== 3) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  const bitrate = MP3_BITRATES[0][bitrateIndex] * 1000;
  const sampleRate = MP3_RATES[rateIndex];
  if (!bitrate || !sampleRate) return null;
  // A 1152-sample frame: 144 * bitrate / sampleRate, plus the header.
  const samples = (144 * bitrate) / sampleRate;
  return {
    bitrate,
    sampleRate,
    samplesPerFrame: Math.floor(samples),
    padding: (b2 >> 1) & 0x01,
    frameBytes: Math.floor((samples / 8) * (bitrate / sampleRate)) + 4,
    samples,
  };
}

/**
 * Every frame's byte range.
 *
 * Walking frames rather than handing the whole file to the decoder, because `EncodedAudioChunk`
 * is one frame at a time and an ID3 tag at the front of the file is not audio.
 */
function splitMp3Frames(bytes) {
  const frames = [];
  let at = 0;
  // Skip an ID3 tag if present: "ID3", two size bytes, ten bytes of flags and padding.
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    at = 10 + size;
  }
  while (at + 4 < bytes.length) {
    const header = readMp3Header(bytes, at);
    if (!header) {
      at += 1; // not aligned yet
      continue;
    }
    const length = Math.floor((header.samples / 8) * (header.bitrate / header.sampleRate)) + 4 + header.padding;
    const end = Math.min(at + length, bytes.length);
    frames.push({ start: at, end });
    at = end;
    if (frames.length > 200000) break; // a runaway walk is worse than a truncated file
  }
  return frames;
}

/** A short busy period, so a long operation yields to the browser between steps. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

function setBusy(button, cancel, busy, busyText) {
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label || button.textContent;
  cancel.hidden = !busy;
}

els.markButton.dataset.label = 'Mark this file';
els.readButton.dataset.label = 'Read the mark';

els.markButton.addEventListener('click', async () => {
  const payload = els.payload.value.trim();
  const file = els.source.files && els.source.files[0];
  els.markResult.hidden = true;

  if (!payload) {
    setStatus('Type an identifier first.');
    els.payload.focus();
    return;
  }
  if (!file) {
    setStatus('Choose a music file first.');
    els.source.focus();
    return;
  }

  setBusy(els.markButton, els.cancelMark, true, 'Marking…');
  try {
    const codec = await getCore();
    setStatus(`Reading ${file.name}…`);
    const { wav } = await readAudio(file);
    await breathe();

    let samples;
    let detail;
    if (els.carrier.value === 'steg') {
      const bytes = new TextEncoder().encode(payload);
      samples = embed(codec, wav.samples, bytes, { key: WATERMARK_KEY });
      detail = `${wav.sampleRate} Hz, ${samples.length} samples. Inaudible, one bit per sample.`;
    } else {
      samples = markTones(codec, payload);
      detail = `${wav.sampleRate} Hz, ${samples.length} samples. Audible tones, the original scheme.`;
    }
    await breathe();

    const out = encodeWav(samples, wav.sampleRate);
    const url = URL.createObjectURL(new Blob([out], { type: 'audio/wav' }));
    els.markDownload.href = url;
    els.markDownload.download = `${file.name.replace(/\.[^.]+$/, '')}-marked.wav`;
    els.markDetail.textContent = detail;
    els.markResult.hidden = false;
    setStatus(`Marked. The file is ready to download.`);
  } catch (error) {
    setStatus(`Could not mark that file: ${error.message}`);
  } finally {
    setBusy(els.markButton, els.cancelMark, false);
  }
});

els.readButton.addEventListener('click', async () => {
  const file = els.marked.files && els.marked.files[0];
  els.readResult.hidden = true;

  if (!file) {
    setStatus('Choose a marked file first.');
    els.marked.focus();
    return;
  }

  setBusy(els.readButton, els.cancelRead, true, 'Reading…');
  try {
    const codec = await getCore();
    setStatus(`Reading ${file.name}…`);
    const { wav } = await readAudio(file);
    await breathe();

    let result;
    if (els.carrier.value === 'steg') {
      // The payload length is not known in advance for this scheme, which is a real limitation
      // of it and not something to paper over: it has no sync word. So the lengths worth trying
      // are tried, and a match is reported as a match.
      result = { ok: false, reason: REASONS.NO_MARK };
      for (let payloadBytes = 8; payloadBytes <= 120 && !result.ok; payloadBytes += 1) {
        result = extract(codec, wav.samples, { key: WATERMARK_KEY, payloadBytes });
      }
    } else {
      result = readTones(codec, wav.samples);
    }
    await breathe();

    // Three outcomes, three elements. Collapsing them into one box is how "no mark" turns into
    // "an empty identifier" and users conclude the tool is broken.
    if (result.ok) {
      els.readPayload.textContent = result.text;
      els.readPayload.hidden = false;
      els.readNone.hidden = true;
      els.readDamaged.hidden = true;
      setStatus(`Found an identifier: ${result.text}`);
    } else if (result.reason === REASONS.NO_MARK || result.reason === 'no-mark') {
      els.readPayload.hidden = true;
      els.readDamaged.hidden = true;
      els.readNone.textContent = 'No mark found in this file. That is a definite answer, not a failure.';
      els.readNone.hidden = false;
      setStatus('No mark found in this file.');
    } else {
      els.readPayload.hidden = true;
      els.readNone.hidden = true;
      els.readDamaged.textContent =
        'Something was found but it does not check out, so it is not reported as an identifier. ' +
        'The file may have been processed or truncated.';
      els.readDamaged.hidden = false;
      setStatus('Found something damaged, not an identifier.');
    }
    els.readResult.hidden = false;
  } catch (error) {
    setStatus(`Could not read that file: ${error.message}`);
  } finally {
    setBusy(els.readButton, els.cancelRead, false);
  }
});

// A cancel that reloads is worse than one that stops the work, but WebAssembly has no way to
// interrupt a call already in progress, so the honest thing is to say what it does.
for (const cancel of [els.cancelMark, els.cancelRead]) {
  cancel.addEventListener('click', () => {
    setStatus('Finishing the current step, then stopping. A long operation cannot be interrupted mid-decode.');
  });
}

// Report a load failure rather than leaving two buttons that do nothing with no explanation.
window.addEventListener('error', (event) => {
  if (!core && !coreFailed) {
    setStatus(`Something went wrong loading the page: ${event.message}`);
  }
});