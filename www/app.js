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
import { readAudioFile } from './src/audio-browser.js';
import { mark as markTones, read as readTones, TONE_RATE } from './src/mark.js';
import { encodeWav, encodeWavChannels, outputBitsFor } from './src/wav.js';
import * as spread from './src/spread.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  payload: $('payload'),
  payloadCount: $('payload-count'),
  carrier: $('carrier'),
  key: $('key'),
  keyField: $('key-field'),
  sourceField: $('source-field'),
  source: $('source'),
  sourceInfo: $('source-info'),
  markButton: $('mark-button'),
  markResult: $('mark-result'),
  markDownload: $('mark-download'),
  markDetail: $('mark-detail'),
  readKey: $('read-key'),
  marked: $('marked'),
  markedInfo: $('marked-info'),
  readButton: $('read-button'),
  readResult: $('read-result'),
  readPayload: $('read-payload'),
  readNone: $('read-none'),
  readDamaged: $('read-damaged'),
  readDetail: $('read-detail'),
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

/** A short busy period, so a long operation yields to the browser between steps. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

function setBusy(button, busy, busyText) {
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label || button.textContent;
}

els.markButton.dataset.label = 'Mark this file';
els.readButton.dataset.label = 'Read the mark';

/** Minutes and seconds, for a length a person will compare against their track. */
function clock(seconds) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The tone scheme does not use a music file, so the chooser is left out rather than ignored. */
function syncScheme() {
  const tones = els.carrier.value === 'tones';
  els.sourceField.hidden = tones;
  els.keyField.hidden = tones;
}
els.carrier.addEventListener('change', syncScheme);
syncScheme();

/** Channels averaged into one, for the tone reader, which is mono by definition. */
function fold(channelData) {
  if (channelData.length === 1) return channelData[0];
  const out = new Float32Array(channelData[0].length);
  for (const channel of channelData) {
    for (let i = 0; i < out.length; i += 1) out[i] += channel[i] / channelData.length;
  }
  return out;
}

els.markButton.addEventListener('click', async () => {
  const payload = els.payload.value.trim();
  const tones = els.carrier.value === 'tones';
  const file = els.source.files && els.source.files[0];
  els.markResult.hidden = true;

  if (!payload) {
    setStatus('Type an identifier first.');
    els.payload.focus();
    return;
  }
  if (!tones && !file) {
    setStatus('Choose a music file first.');
    els.source.focus();
    return;
  }

  setBusy(els.markButton, true, 'Marking…');
  try {
    const codec = await getCore();
    let wavBytes;
    let name;
    let detail;

    if (tones) {
      const samples = markTones(codec, payload);
      wavBytes = encodeWav(samples, TONE_RATE);
      name = 'marked-tones.wav';
      detail = `${TONE_RATE} Hz mono, ${clock(samples.length / TONE_RATE)}. Audible tones, the original scheme. This is a new file of beeps, not your music.`;
    } else {
      setStatus(`Reading ${file.name}…`);
      const audio = await readAudioFile(file);
      await breathe();

      const bytes = new TextEncoder().encode(payload);
      const needed = spread.minSamples(codec, bytes.length, audio.sampleRate);
      if (audio.frames < needed) {
        throw new Error(
          `this track is ${clock(audio.frames / audio.sampleRate)} long and a mark with an identifier this long ` +
            `needs at least ${clock(needed / audio.sampleRate)}. A shorter identifier needs less.`,
        );
      }

      setStatus(`Marking ${plural(audio.channels, 'channel')}…`);
      await breathe();
      const key = spread.keyFromText(els.key.value);
      const marked = spread.embed(codec, audio.channelData, bytes, { key, sampleRate: audio.sampleRate });
      await breathe();

      // A WAV keeps its own depth, so marking a 24-bit master does not cut it to 16. An MP3 has no
      // depth to keep and is written 16-bit.
      const bits = audio.kind === 'wav' ? outputBitsFor(audio) : 16;
      wavBytes = encodeWavChannels(marked, audio.sampleRate, { bits });
      name = `${file.name.replace(/\.[^.]+$/, '')}-marked.wav`;
      const copies = Math.floor(audio.frames / needed);
      detail =
        `${audio.sampleRate} Hz, ${plural(audio.channels, 'channel')}, ${clock(audio.frames / audio.sampleRate)}. ` +
        `${plural(copies, 'copy')} of the mark${copies > 1 ? ', which is what lets it survive damage' : ''}. ` +
        `${els.key.value.trim() ? 'Made with your key.' : 'Made with the public default key, so anyone can read it.'} ` +
        `Written as a ${bits === 32 ? '32-bit float' : `${bits}-bit`} WAV${audio.kind === 'mp3' ? ' (an MP3 has no bit depth of its own)' : ''}.`;
    }

    if (els.markDownload.href.startsWith('blob:')) URL.revokeObjectURL(els.markDownload.href);
    els.markDownload.href = URL.createObjectURL(new Blob([wavBytes], { type: 'audio/wav' }));
    els.markDownload.download = name;
    els.markDetail.textContent = detail;
    els.markResult.hidden = false;
    setStatus('Marked. The file is ready to download below.');
    els.markResult.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    setStatus(`Could not mark that file: ${error.message}`);
  } finally {
    setBusy(els.markButton, false);
  }
});

function showResult({ text, none, damaged, detail }) {
  els.readPayload.hidden = text === undefined;
  els.readNone.hidden = !none;
  els.readDamaged.hidden = !damaged;
  if (text !== undefined) els.readPayload.textContent = text;
  if (none) els.readNone.textContent = none;
  if (damaged) els.readDamaged.textContent = damaged;
  els.readDetail.hidden = !detail;
  if (detail) els.readDetail.textContent = detail;
  els.readResult.hidden = false;
  els.readResult.scrollIntoView({ block: 'nearest' });
}

els.readButton.addEventListener('click', async () => {
  const file = els.marked.files && els.marked.files[0];
  els.readResult.hidden = true;

  if (!file) {
    setStatus('Choose a marked file first.');
    els.marked.focus();
    return;
  }

  setBusy(els.readButton, true, 'Reading…');
  try {
    const codec = await getCore();
    setStatus(`Reading ${file.name}…`);
    const audio = await readAudioFile(file);
    await breathe();
    const shape = `${audio.sampleRate} Hz, ${plural(audio.channels, 'channel')}, ${clock(audio.frames / audio.sampleRate)}`;

    // Three outcomes, three elements. Collapsing them into one box is how "no mark" turns into
    // "an empty identifier" and users conclude the tool is broken. The watermark is looked for
    // first, then the tones, and a damaged find from either is kept in case the other finds nothing.
    let damaged = false;

    const key = spread.keyFromText(els.readKey.value);
    const w = spread.detect(codec, audio.channelData, { key, sampleRate: audio.sampleRate });
    await breathe();
    if (w.ok) {
      const text = new TextDecoder().decode(w.payload);
      // A file played slower or faster than it was marked is read by correcting for it, and a
      // person who is told it was is better placed than one who thinks it was untouched.
      const drift = (w.speed - 1) * 100;
      const speedNote = Math.abs(drift) >= 0.0001
        ? ` The file runs ${Math.abs(drift).toPrecision(2)}% ${drift > 0 ? 'slower' : 'faster'} than it was marked, and was corrected for.`
        : '';
      showResult({ text, detail: `Found by the watermark reader. ${shape}. The checksum matched.${speedNote}` });
      setStatus(`Found an identifier: ${text}`);
      return;
    }
    damaged = w.reason === 'damaged';

    // The tone reader works at one rate only, so a file at another rate is not read by it, and
    // the page says so instead of reporting a mark that is merely out of range.
    let tonesSkipped = false;
    if (audio.sampleRate === TONE_RATE) {
      const t = readTones(codec, fold(audio.channelData));
      if (t.ok) {
        showResult({ text: t.text, detail: `Found by the tone reader. ${shape}. The checksum matched.` });
        setStatus(`Found an identifier: ${t.text}`);
        return;
      }
      damaged = damaged || (t.reason !== 'no-mark');
    } else {
      tonesSkipped = true;
    }

    if (damaged) {
      showResult({
        damaged:
          'Something was found but it does not check out, so it is not reported as an identifier. ' +
          'The file may have been processed or truncated.',
        detail: shape,
      });
      setStatus('Found something damaged, not an identifier.');
    } else {
      showResult({
        none:
          'No mark found in this file. That is a definite answer, not a failure. If the mark was made with a key, ' +
          'this is also what a wrong or missing key looks like.',
        detail: `${shape}.${tonesSkipped ? ` The tone reader only reads ${TONE_RATE} Hz files, so it was not tried.` : ''}`,
      });
      setStatus('No mark found in this file.');
    }
  } catch (error) {
    setStatus(`Could not read that file: ${error.message}`);
  } finally {
    setBusy(els.readButton, false);
  }
});

// Report a load failure rather than leaving two buttons that do nothing with no explanation.
window.addEventListener('error', (event) => {
  if (!core && !coreFailed) {
    setStatus(`Something went wrong loading the page: ${event.message}`);
  }
});
