// www/browser-check.js
//
// Drive the real page in a real browser: load the Wasm, mark a file, read it back.
//
// This is the check that the whole container arrangement exists to make possible, and it is not
// something the Vitest suite can do: loading a module over HTTP, compiling it, and calling into it
// needs a browser with a fetch and a WebAssembly. A DOM without a renderer has none of those.
//
// Run against a running container:
//   node www/browser-check.js http://127.0.0.1:8080
//
// Chrome grants no user activation to a tab whose visibilityState is hidden, so this reports
// `navigator.userActivation.hasBeenActive` before concluding anything from a hang: false means
// the environment, not the code.

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { synthTrack } from '../src/synth.js';
import { encodeWavChannels } from '../src/wav.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
/** A path under BASE, so the check works against a site served at a prefix such as /fluidmark. */
const at = (path) => `${BASE}${path}`;
const CHROME = process.env.CHROME || 'google-chrome';
const PORT = 9222 + (process.pid % 500);

/** A short WAV to feed the page: a chord, so no single frequency dominates. */
function makeWav(seconds = 1, rate = 22050) {
  const n = Math.round(rate * seconds);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const v = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t);
    pcm[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  }
  const buf = Buffer.alloc(44 + pcm.byteLength);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.byteLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer).copy(buf, 44);
  return buf;
}

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Chrome did not expose a debugging port');
}

async function main() {
  const wav = '/tmp/fluidmark-check.wav';
  writeFileSync(wav, makeWav());

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--user-data-dir=/tmp/fluidmark-chrome-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let failures = 0;
  const check = (ok, what) => {
    process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}\n`);
    if (!ok) failures += 1;
  };

  try {
    const version = await waitForDevtools();
    process.stdout.write(`driving ${version.Browser}\n`);

    // Load the page in a tab and drive it over the DevTools protocol. No puppeteer: the point is
    // to check the page, and adding a browser-automation dependency to assert that a page works
    // would be a dependency nobody wants for the sake of a check.
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    // Node 20, which the project supports, has no global WebSocket (22 has); `ws` is a devDependency for that.
    const WS = globalThis.WebSocket ?? (await import('ws')).WebSocket;
    const socket = new WS(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });

    const send = (method, params = {}) =>
      new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });

    /** Evaluate an expression in the page and return its value. */
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.result?.exceptionDetails) {
        throw new Error(result.result.exceptionDetails.exception?.description || 'exception');
      }
      return result.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    // 360px, not the headless default of about 780. The narrow case is the one that has to hold:
    // at desktop width a layout with a fixed-width child looks fine and is unusable on a phone.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 720,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await send('Page.navigate', { url: at('/index.html') });
    await new Promise((r) => setTimeout(r, 1500));

    check(
      (await evaluate('document.title')).includes('FluidMark'),
      'the page loads and has a title',
    );
    check(await evaluate('document.documentElement.lang === "en"'), 'the page states its language');
    check(
      await evaluate('!!document.querySelector(\'meta[name="viewport"]\')'),
      'the page has a viewport',
    );

    // The thing that matters: the module loads over HTTP and the codec initialises.
    const loaded = await evaluate(
      `(async () => {
        try {
          const { loadCore } = await import('${BASE}/src/load-browser.js');
          const core = await loadCore();
          const info = { abi: core.abiVersion(), bytes: core.memory.buffer.byteLength };
          core.destroy();
          return JSON.stringify(info);
        } catch (error) {
          return JSON.stringify({ error: String(error) });
        }
      })()`,
    );
    const coreInfo = JSON.parse(loaded);
    check(!coreInfo.error, `the Wasm core loads over HTTP ${coreInfo.error || ''}`);
    check(coreInfo.abi === 1, `the core reports ABI 1, got ${coreInfo.abi}`);
    check(coreInfo.bytes > 0, 'the core has linear memory');

    // The whole round trip, in the page, through the same functions the buttons call.
    const roundTrip = JSON.parse(
      await evaluate(
        `(async () => {
          const { loadCore } = await import('${BASE}/src/load-browser.js');
          const { mark, read } = await import('${BASE}/src/mark.js');
          const { decodeWav, encodeWav } = await import('${BASE}/src/wav.js');
          const core = await loadCore();
          const rate = 22050;
          const n = rate;
          const samples = new Float32Array(n);
          for (let i = 0; i < n; i += 1) {
            const t = i / rate;
            samples[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t);
          }
          const result = read(core, mark(core, 'browser check', { punycode: false }), { punycode: false });
          core.destroy();
          return JSON.stringify({ ok: result.ok, text: result.text, reason: result.reason });
        })()`,
      ),
    );
    check(roundTrip.ok, `a payload round trips in the browser ${roundTrip.reason || ''}`);
    check(roundTrip.text === 'browser check', `the text came back as ${JSON.stringify(roundTrip.text)}`);

    // The real thing: drive the page's own controls, with real files, the way a person does.
    // Everything below goes through `index.html` and `app.js`, so a broken import, a renamed id, a
    // handler that never attached or an error shown out of sight fails here and nowhere else.
    await send('DOM.enable');
    const root = (await send('DOM.getDocument')).result.root.nodeId;
    const setFile = async (selector, path) => {
      const node = (await send('DOM.querySelector', { nodeId: root, selector })).result.nodeId;
      await send('DOM.setFileInputFiles', { nodeId: node, files: [path] });
    };
    /** Poll the page until `expression` is truthy, or say it never was. */
    const until = async (expression, what, ms = 90000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (await evaluate(`Boolean(${expression})`)) {
          check(true, what);
          return true;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      check(false, `${what} (timed out after ${ms / 1000}s; status: ${JSON.stringify(await evaluate('document.getElementById("status").textContent'))})`);
      return false;
    };
    const status = () => evaluate('document.getElementById("status").textContent');
    const setValue = (id, value) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);

    mkdirSync('/tmp/fluidmark-check', { recursive: true });
    // 18 s of stereo with different left and right, at 44.1 kHz. Long enough for one copy of a
    // short identifier, short enough to be quick. Not music, but not a tone either.
    const stereoWav = '/tmp/fluidmark-check/stereo.wav';
    writeFileSync(stereoWav, encodeWavChannels([synthTrack(18, 44100, 31), synthTrack(18, 44100, 32)], 44100));
    const shortWav = '/tmp/fluidmark-check/short.wav';
    writeFileSync(shortWav, encodeWavChannels([synthTrack(3, 44100, 33), synthTrack(3, 44100, 34)], 44100));
    const flac = '/tmp/fluidmark-check/not-supported.flac';
    writeFileSync(flac, Buffer.from('fLaC' + 'x'.repeat(200)));
    let stereoMp3 = null;
    try {
      stereoMp3 = '/tmp/fluidmark-check/stereo.mp3';
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', stereoWav, '-b:a', '128k', stereoMp3]);
    } catch {
      stereoMp3 = null;
    }

    // 1. A failure is visible from where the button is. The short file cannot hold a mark.
    await setValue('payload', 'urn:x:1');
    await setFile('#source', shortWav);
    await evaluate('document.getElementById("mark-button").scrollIntoView()');
    await click('mark-button');
    await until('/needs at least/.test(document.getElementById("status").textContent)', 'a too-short file is refused with a reason', 30000);
    const inView = await evaluate(`(() => { const r = document.getElementById('status').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0; })()`);
    check(inView, 'the failure message is on screen while the button is, not stranded at the top of the page');
    check(!(await evaluate('document.getElementById("mark-button").disabled')), 'the button is usable again after a failure');

    // 2. A format the page cannot read is refused by name.
    await setFile('#source', flac);
    await click('mark-button');
    await until('/not a WAV or an MP3/.test(document.getElementById("status").textContent)', 'an unsupported file is refused by name', 30000);

    // 3. Stereo in, stereo out, with a key; then read it back through the page's own Read control.
    await setFile('#source', stereoWav);
    await setValue('key', 'a check phrase');
    await click('mark-button');
    if (await until('!document.getElementById("mark-result").hidden', 'a stereo WAV is marked through the page')) {
      const made = JSON.parse(await evaluate(`(async () => {
        const link = document.getElementById('mark-download');
        const bytes = new Uint8Array(await (await fetch(link.href)).arrayBuffer());
        const view = new DataView(bytes.buffer);
        return JSON.stringify({ channels: view.getUint16(22, true), rate: view.getUint32(24, true), bytes: bytes.length, name: link.download, detail: document.getElementById('mark-detail').textContent });
      })()`));
      check(made.channels === 2, `the marked file is stereo (${made.channels} channels)`);
      check(made.rate === 44100, `and keeps its sample rate (${made.rate})`);
      check(made.name === 'stereo-marked.wav', `and is named from the source (${made.name})`);
      check(/2 channels/.test(made.detail) && /your key/.test(made.detail), `the detail says what was done: ${made.detail}`);

      // Hand the blob that was just made to the Read control, as a person would hand it a file.
      const feed = (key) => evaluate(`(async () => {
        const blob = await (await fetch(document.getElementById('mark-download').href)).blob();
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'round-trip.wav', { type: 'audio/wav' }));
        document.getElementById('marked').files = transfer.files;
        document.getElementById('marked').dispatchEvent(new Event('change', { bubbles: true }));
        const keyEl = document.getElementById('read-key');
        keyEl.value = ${JSON.stringify(key)};
        document.getElementById('read-result').hidden = true;
        document.getElementById('read-button').click();
      })()`);
      await feed('a check phrase');
      if (await until('!document.getElementById("read-result").hidden', 'the marked file is read back')) {
        const found = JSON.parse(await evaluate(`JSON.stringify({ text: document.getElementById('read-payload').hidden ? null : document.getElementById('read-payload').textContent, detail: document.getElementById('read-detail').textContent })`));
        check(found.text === 'urn:x:1', `the identifier came back through the page: ${JSON.stringify(found.text)}`);
        check(/watermark reader/.test(found.detail), `and says how it was found: ${found.detail}`);
      }
      // The wrong key must say "no mark", in its own element, and never an identifier.
      await feed('a different phrase');
      if (await until('!document.getElementById("read-result").hidden && !document.getElementById("read-none").hidden', 'the wrong key reads as no mark')) {
        check(await evaluate('document.getElementById("read-payload").hidden'), 'and shows no identifier');
      }
    }

    // 4. Unmarked audio reads as no mark, through the page.
    await setFile('#marked', stereoWav);
    await setValue('read-key', 'a check phrase');
    await evaluate('document.getElementById("read-result").hidden = true');
    await click('read-button');
    if (await until('!document.getElementById("read-result").hidden', 'an unmarked file is read')) {
      check(await evaluate('!document.getElementById("read-none").hidden && document.getElementById("read-payload").hidden'), 'an unmarked file reports no mark and no identifier');
    }

    // 5. The files the old service made: MPEG-2, 22.05 kHz, mono, read by the tone reader.
    await setFile('#marked', `${ROOT}reference/WebBeep/www/audio/dfgdfg.mp3`);
    await setValue('read-key', '');
    await evaluate('document.getElementById("read-result").hidden = true');
    await click('read-button');
    if (await until('!document.getElementById("read-result").hidden || /Could not read/.test(document.getElementById("status").textContent)', 'an old service MP3 is read', 60000)) {
      const text = await evaluate('document.getElementById("read-payload").hidden ? null : document.getElementById("read-payload").textContent');
      check(text === 'dfgdfg', `a legacy MP3 reads as 'dfgdfg' (${JSON.stringify(text)}; status ${JSON.stringify(await status())})`);
    }

    // 6. A stereo MPEG-1 MP3 is decoded by the browser and marked. Needs ffmpeg to make the file and
    // WebCodecs in the browser; either missing is reported as skipped, not as a pass.
    if (stereoMp3) {
      const hasDecoder = await evaluate('typeof AudioDecoder !== "undefined"');
      if (!hasDecoder) {
        process.stdout.write('  skip  a stereo MP3 is decoded and marked (this browser has no AudioDecoder)\n');
      } else {
        await setFile('#source', stereoMp3);
        await evaluate('document.getElementById("mark-result").hidden = true');
        await click('mark-button');
        if (await until('!document.getElementById("mark-result").hidden || /Could not mark/.test(document.getElementById("status").textContent)', 'a stereo MP3 is marked', 90000)) {
          const detail = await evaluate('document.getElementById("mark-result").hidden ? document.getElementById("status").textContent : document.getElementById("mark-detail").textContent');
          check(/2 channels/.test(detail) && /44100 Hz/.test(detail), `a stereo MP3 decodes to 2 channels at 44100 Hz and is marked: ${detail}`);
        }
      }
    } else {
      process.stdout.write('  skip  a stereo MP3 is decoded and marked (ffmpeg is not installed)\n');
    }

    // 6b. A 24-bit master stays 24-bit, rather than being cut to 16 on its way through the page.
    const wav24 = '/tmp/fluidmark-check/stereo24.wav';
    writeFileSync(wav24, encodeWavChannels([synthTrack(18, 44100, 41), synthTrack(18, 44100, 42)], 44100, { bits: 24 }));
    await setValue('payload', 'urn:x:1');
    await setFile('#source', wav24);
    await evaluate('document.getElementById("mark-result").hidden = true');
    await click('mark-button');
    if (await until('!document.getElementById("mark-result").hidden', 'a 24-bit stereo WAV is marked')) {
      const bits = await evaluate(`(async () => { const b = new Uint8Array(await (await fetch(document.getElementById('mark-download').href)).arrayBuffer()); return new DataView(b.buffer).getUint16(34, true); })()`);
      check(bits === 24, `and written back 24-bit (${bits}; ${await evaluate('document.getElementById("mark-detail").textContent')})`);
    }

    // 6c. Cancel really stops a long job, and the page works afterwards. A five-minute unmarked file takes the
    // reader long enough to be cancelled part-way, and the buttons are only ever reachable because the work is
    // in a worker and the page is not frozen.
    const longWav = '/tmp/fluidmark-check/long.wav';
    writeFileSync(longWav, encodeWavChannels([synthTrack(300, 44100, 51), synthTrack(300, 44100, 52)], 44100));
    await setFile('#marked', longWav);
    await setValue('read-key', 'another phrase entirely');
    await evaluate('document.getElementById("read-result").hidden = true');
    await click('read-button');
    if (await until('!document.getElementById("cancel-read").hidden', 'a Cancel button appears while a long read is running', 30000)) {
      await click('cancel-read');
      await until('/Cancelled/.test(document.getElementById("status").textContent)', 'cancelling a long read says so', 10000);
      check(await evaluate('document.getElementById("cancel-read").hidden && !document.getElementById("read-button").disabled'), 'and the buttons are back: Cancel gone, Read usable');
      check(await evaluate('document.getElementById("read-result").hidden'), 'and no result was shown for the cancelled job');
    }
    // A new job after a cancel starts a fresh worker and works.
    await setFile('#marked', stereoWav);
    await evaluate('document.getElementById("read-result").hidden = true');
    await click('read-button');
    await until('!document.getElementById("read-result").hidden', 'a read after a cancel works', 60000);

    // 7. The tone scheme needs no music file and says it is not using one.
    await setValue('carrier', 'tones');
    check(await evaluate('document.getElementById("source-field").hidden'), 'the tone scheme leaves out the music file chooser');
    await setValue('payload', 'abc');
    await evaluate('document.getElementById("mark-result").hidden = true');
    await click('mark-button');
    if (await until('!document.getElementById("mark-result").hidden', 'the tone scheme marks without a file')) {
      const rate = await evaluate(`(async () => { const b = new Uint8Array(await (await fetch(document.getElementById('mark-download').href)).arrayBuffer()); return new DataView(b.buffer).getUint32(24, true); })()`);
      check(rate === 22050, `the tones are written at 22050 Hz, which is the rate they are read at (${rate})`);
    }

    // Layout, which is the measurement the DOM-only tests cannot make.
    const layout = JSON.parse(
      await evaluate(
        `JSON.stringify({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          targets: [...document.querySelectorAll('button, input, select, a.download')]
            .map((el) => ({ tag: el.tagName, h: Math.round(el.getBoundingClientRect().height) }))
            .filter((t) => t.h > 0 && t.h < 44),
          fontSizes: [...document.querySelectorAll('input[type="text"], select')]
            .map((el) => parseFloat(getComputedStyle(el).fontSize)),
          active: navigator.userActivation.hasBeenActive,
        })`,
      ),
    );
    check(
      layout.scrollWidth <= layout.innerWidth + 1,
      `no horizontal scrolling at 360px (scrollWidth ${layout.scrollWidth}, innerWidth ${layout.innerWidth})`,
    );
    check(
      layout.targets.length === 0,
      `every visible target is at least 44px tall: ${JSON.stringify(layout.targets)}`,
    );
    check(
      layout.fontSizes.every((size) => size >= 16),
      `text inputs are at least 16px: ${JSON.stringify(layout.fontSizes)}`,
    );

    // Focus order, which is also invisible without a renderer: every control must be reachable.
    const focus = JSON.parse(
      await evaluate(
        `(async () => {
          const order = [];
          for (let i = 0; i < 12; i += 1) {
            // Not a real key press: scripted focus is enough to see whether an element is
            // focusable at all, and a real key press is in HUMANS.md.
            // Visible controls only. A hidden control is not focusable, which is correct: the
            // cancel buttons appear when a job starts, and a button nobody can reach is not a
            // control.
            const visible = [...document.querySelectorAll('a[href], button, input, select, [tabindex]')]
              .filter((candidate) => candidate.offsetParent !== null || candidate === document.activeElement);
            const el = visible[i];
            if (!el) break;
            el.focus();
            order.push(document.activeElement === el ? (el.id || el.tagName) : 'NOT-FOCUSABLE');
          }
          return JSON.stringify(order);
        })()`,
      ),
    );
    check(
      !focus.some((entry) => entry === 'NOT-FOCUSABLE'),
      `every control is focusable: ${JSON.stringify(focus)}`,
    );

    socket.close();
  } finally {
    chrome.kill('SIGKILL');
  }

  process.stdout.write(failures === 0 ? '\nbrowser check: passed\n' : `\nbrowser check: ${failures} failure(s)\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });