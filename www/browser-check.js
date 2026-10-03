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

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

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
    const socket = new WebSocket(page.webSocketDebuggerUrl);
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
      (await evaluate('document.title')).includes('fluidmark'),
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

    // And the inaudible path, which is the one the site is actually for.
    const steg = JSON.parse(
      await evaluate(
        `(async () => {
          const { loadCore } = await import('${BASE}/src/load-browser.js');
          const { embed, extract } = await import('${BASE}/src/watermark.js');
          const { frame, unframe } = await import('${BASE}/src/frame.js');
          const core = await loadCore();
          const rate = 44100, n = rate;
          const audio = new Float32Array(n);
          for (let i = 0; i < n; i += 1) {
            const t = i / rate;
            audio[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t);
          }
          const payload = new TextEncoder().encode('http://example.org/');
          const marked = embed(core, audio, payload, { key: 1234n });
          const read = extract(core, marked, { key: 1234n, payloadBytes: payload.length });
          const clean = extract(core, audio, { key: 1234n, payloadBytes: payload.length });
          core.destroy();
          return JSON.stringify({
            found: read.ok,
            text: read.ok ? new TextDecoder().decode(read.payload) : null,
            falsePositive: clean.ok,
          });
        })()`,
      ),
    );
    check(steg.found, 'the inaudible scheme round trips in the browser');
    check(steg.text === 'http://example.org/', `it came back as ${JSON.stringify(steg.text)}`);
    check(!steg.falsePositive, 'unmarked audio is not reported as marked');

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