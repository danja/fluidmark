// www/app.js
//
// The page's behaviour. Vanilla JavaScript, no framework, no build step beyond the Wasm module.
//
// Two operations, matching the previous site: mark a file with an identifier, and read an
// identifier back out of a marked file. Both run in this browser, in a worker (`worker.js`) so that a long
// file does not freeze the page and Cancel can really stop it. Nothing is uploaded, and the only reason that
// is true is that the codec is here rather than on a server.
//
// Every element is reached by id, and `tests/web.test.js` asserts each id is still here. An
// element that has gone is a null dereference at the moment a user presses a button, which is the
// worst time to find out.

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
  cancelMark: $('cancel-mark'),
  markResult: $('mark-result'),
  markDownload: $('mark-download'),
  markDetail: $('mark-detail'),
  readKey: $('read-key'),
  marked: $('marked'),
  markedInfo: $('marked-info'),
  readButton: $('read-button'),
  cancelRead: $('cancel-read'),
  readResult: $('read-result'),
  readPayload: $('read-payload'),
  readNone: $('read-none'),
  readDamaged: $('read-damaged'),
  readDetail: $('read-detail'),
};

/**
 * The worker the work runs in, made on first use.
 *
 * Relative to this file, so it stays under whatever path the site is served at. A worker that cannot start, a
 * missing file or a blocked module, reports through `onerror` and is said so in words, not left as two buttons
 * that do nothing.
 */
let worker = null;
let current = null; // { resolve, reject, onStatus } for the job in flight

function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const m = event.data;
    if (!current) return;
    if (m.type === 'status') current.onStatus(m.text);
    else if (m.type === 'result') { const job = current; current = null; job.resolve(m.result); }
    else if (m.type === 'error') { const job = current; current = null; job.reject(new Error(m.message)); }
  };
  worker.onerror = (event) => {
    const job = current;
    current = null;
    worker = null;
    if (job) job.reject(new Error(`the page's worker failed to start or crashed: ${event.message || 'no reason given'}`));
  };
}

/** Run a job in the worker, with `onStatus` told what stage it is at. Resolves with its result. */
function runJob(message, onStatus) {
  if (current) return Promise.reject(new Error('a job is already running'));
  if (!worker) startWorker();
  return new Promise((resolve, reject) => {
    current = { resolve, reject, onStatus };
    worker.postMessage(message);
  });
}

/** Stop the job in flight. Terminating the worker is the only way to interrupt a call into Wasm, and it is one. */
function cancelJob() {
  if (!current) return;
  const job = current;
  current = null;
  worker.terminate();
  worker = null;
  job.reject(new Error('cancelled'));
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

function setBusy(button, cancel, busy, busyText) {
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.label || button.textContent;
  // The cancel button exists only while there is something to cancel, and what it does is real.
  cancel.hidden = !busy;
}

els.markButton.dataset.label = 'Mark this file';
els.readButton.dataset.label = 'Read the mark';

/** The tone scheme does not use a music file, so the chooser is left out rather than ignored. */
function syncScheme() {
  const tones = els.carrier.value === 'tones';
  els.sourceField.hidden = tones;
  els.keyField.hidden = tones;
}
els.carrier.addEventListener('change', syncScheme);
syncScheme();

els.markButton.addEventListener('click', async () => {
  const payload = els.payload.value.trim();
  const scheme = els.carrier.value === 'tones' ? 'tones' : 'watermark';
  const file = els.source.files && els.source.files[0];
  els.markResult.hidden = true;

  if (!payload) {
    setStatus('Type an identifier first.');
    els.payload.focus();
    return;
  }
  if (scheme === 'watermark' && !file) {
    setStatus('Choose a music file first.');
    els.source.focus();
    return;
  }

  setBusy(els.markButton, els.cancelMark, true, 'Marking…');
  try {
    const done = await runJob({ op: 'mark', file, payload, scheme, keyText: els.key.value }, setStatus);
    if (els.markDownload.href.startsWith('blob:')) URL.revokeObjectURL(els.markDownload.href);
    els.markDownload.href = URL.createObjectURL(new Blob([done.wavBytes], { type: 'audio/wav' }));
    els.markDownload.download = done.name;
    els.markDetail.textContent = done.detail;
    els.markResult.hidden = false;
    setStatus('Marked. The file is ready to download below.');
    els.markResult.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    setStatus(error.message === 'cancelled' ? 'Cancelled. Nothing was written.' : `Could not mark that file: ${error.message}`);
  } finally {
    setBusy(els.markButton, els.cancelMark, false);
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

  setBusy(els.readButton, els.cancelRead, true, 'Reading…');
  try {
    const found = await runJob({ op: 'read', file, keyText: els.readKey.value }, setStatus);
    if (found.outcome === 'found') {
      showResult({ text: found.text, detail: found.detail });
      setStatus(`Found an identifier: ${found.text}`);
    } else if (found.outcome === 'damaged') {
      showResult({ damaged: found.damaged, detail: found.detail });
      setStatus('Found something damaged, not an identifier.');
    } else {
      showResult({ none: found.none, detail: found.detail });
      setStatus('No mark found in this file.');
    }
  } catch (error) {
    setStatus(error.message === 'cancelled' ? 'Cancelled.' : `Could not read that file: ${error.message}`);
  } finally {
    setBusy(els.readButton, els.cancelRead, false);
  }
});

els.cancelMark.addEventListener('click', cancelJob);
els.cancelRead.addEventListener('click', cancelJob);
