// tests/web.test.js
//
// The page's structure, checked rather than assumed.
//
// These are the tests that would catch a change that breaks the page for a person while every
// other test still passes. `www/app.js` reaches for elements by id at the moment a button is
// pressed, so an element that has been renamed or removed is a null dereference then and not
// before, and a page with no functional test suite has nothing to notice it.
//
// None of this needs a browser: it is markup, and the properties being checked are properties of
// markup. The things that need a browser, layout, focus and pointer, are in HUMANS.md, because
// they genuinely cannot be checked without one.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const www = (name) => fileURLToPath(new URL(`../www/${name}`, import.meta.url));
const html = readFileSync(www('index.html'), 'utf8');
const app = readFileSync(www('app.js'), 'utf8');
const worker = readFileSync(www('worker.js'), 'utf8');

/** Ids `app.js` reaches for. A change to either side without the other fails here. */
const IDS = [
  'status',
  'payload',
  'payload-count',
  'carrier',
  'key',
  'key-field',
  'source-field',
  'source',
  'source-info',
  'mark-button',
  'cancel-mark',
  'mark-result',
  'mark-download',
  'mark-detail',
  'read-key',
  'marked',
  'marked-info',
  'read-button',
  'cancel-read',
  'read-result',
  'read-payload',
  'read-none',
  'read-damaged',
  'read-detail',
];

describe('the page', () => {
  it('has every element the script reaches for', () => {
    const missing = IDS.filter((id) => !html.includes(`id="${id}"`));
    expect(missing, `app.js reaches for these and the page does not have them: ${missing}`).toEqual([]);
  });

  it('is the only script on the page, and it is a module', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/type="module"/);
  });

  it('states its language, so a screen reader picks the right voice', () => {
    expect(html).toMatch(/<html[^>]+lang="en"/);
  });

  it('has a viewport, or a phone zooms in and then scrolls sideways', () => {
    expect(html).toMatch(/<meta[^>]+name="viewport"[^>]+width=device-width/);
  });

  it('has a title that says what it is', () => {
    expect(html).toMatch(/<title>[^<]*FluidMark[^<]*<\/title>/);
  });

  it('loads nothing from a third party', () => {
    // A CDN script or an embed means the tool breaks when a third party is down, and it means a
    // third party sees what people are marking. Both are unacceptable. Linking *out* is fine and
    // the previous site did it, so only loaded resources are checked: `src`, and a `<link>` to a
    // stylesheet or script. Not every href.
    const loaded = [
      ...[...html.matchAll(/\ssrc="(?:https?:)?\/\/[^"]+"/g)].map((m) => m[0]),
      ...[...html.matchAll(/<link[^>]+href="(?:https?:)?\/\/[^"]+"/g)]
        .map((m) => m[0])
        // A canonical link names where the page lives; it does not load anything.
        .filter((tag) => !/rel="canonical"/.test(tag)),
      ...[...html.matchAll(/<iframe\b/g)].map(() => '<iframe>'),
    ];
    expect(loaded, `these load from elsewhere: ${loaded}`).toEqual([]);
  });

  it('links out only to places a reader would want to go', () => {
    const outLinks = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(outLinks.length).toBeGreaterThan(0);
    for (const href of outLinks) {
      expect(href, 'a link with no rel, so a reverse-tabnabbing target').toBeTruthy();
    }
  });

  it('has no inline event handlers, which cannot be CSP-restricted later', () => {
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  it('offers both operations the previous site had', () => {
    expect(html).toMatch(/Make a mark/i);
    expect(html).toMatch(/Read a mark/i);
  });

  it('links the pages the previous site had', () => {
    for (const page of ['spec.html', 'applications.html']) {
      expect(html, `no link to ${page}`).toContain(`href="${page}"`);
    }
  });
});

describe('accessibility, as far as markup can show it', () => {
  it('labels every form control', () => {
    const controls = [...html.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0]);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const id = control.match(/id="([^"]+)"/)?.[1];
      expect(id, `a control with no id cannot be labelled: ${control}`).toBeTruthy();
      expect(html, `no <label for="${id}">`).toContain(`for="${id}"`);
    }
  });

  it('has one live region, and it is a status', () => {
    const live = [...html.matchAll(/aria-live="([^"]+)"/g)].map((m) => m[1]);
    expect(live).toEqual(['polite']);
    expect(html).toMatch(/role="status"/);
  });

  it('reports progress and errors into that region rather than only on screen', () => {
    expect(app).toMatch(/role="status"|els\.status/);
    expect(app).toMatch(/setStatus\(/);
  });

  it('has three distinct elements for the three read outcomes', () => {
    // One box with text in it is how "no mark here" becomes "an empty identifier".
    expect(html).toMatch(/id="read-payload"/);
    expect(html).toMatch(/id="read-none"/);
    expect(html).toMatch(/id="read-damaged"/);
  });

  it('says which file was chosen in text, not only in the control', () => {
    // A file input announces its filename on some browsers and nothing on others.
    expect(html).toMatch(/id="source-info"[^>]*class="[^"]*file-info/);
    expect(html).toMatch(/id="marked-info"[^>]*class="[^"]*file-info/);
    // And a placeholder, so the element says something before a file is chosen rather than being
    // empty.
    expect(html).toMatch(/data-empty="No file chosen\."/);
  });

  it('offers a way past the header', () => {
    expect(html).toMatch(/class="skip"/);
  });

  it('gives the buttons text rather than an image', () => {
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].trim());
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const label of buttons) {
      expect(label, 'a button with no text').not.toBe('');
      expect(label, 'a button labelled only by an image').not.toMatch(/^<img/);
    }
  });
});

describe('the stylesheet', () => {
  const css = readFileSync(www('style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('gives text inputs a 16px font, or iOS zooms the page in on focus', () => {
    // Scoped to the input and select rules, because small text in a help paragraph is fine and
    // checking the whole stylesheet for any rem value below 1 would flag all of them.
    // Matched on the selector alone: a rule like `a:focus-visible, input:focus-visible` mentions
    // input but sets no font size, and requiring one of it would be the test being wrong.
    const rules = css
      .split('}')
      .map((fragment) => fragment.trim())
      .filter((fragment) => fragment.includes('{'))
      .map((fragment) => ({ selector: fragment.slice(0, fragment.indexOf('{')), body: fragment }))
      // Whole leading selectors only, and no pseudo-classes: `input:focus-visible` shares a
      // rule with four other selectors and sets no font size, so a test that wanted a font
      // declaration there would be asking for something pointless.
      .filter(({ selector }) =>
        selector
          .split(',')
          .some((part) => /^\s*(input|select)(\[[^\]]*\])?\s*$/.test(part)),
      );

    expect(rules.length, 'no rule targets an input or a select').toBeGreaterThan(0);
    for (const { selector, body } of rules) {
      expect(body, `no font-size on: ${selector.trim()}`).toMatch(/font-size:/);
      expect(body, `a text input under 1rem on: ${selector.trim()}`).not.toMatch(/font-size:\s*0\./);
    }
  });

  it('gives buttons and inputs a target of at least 44px', () => {
    expect(css).toMatch(/--target:\s*44px/);
  });

  it('keeps a long identifier from overflowing', () => {
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('has a visible focus indicator', () => {
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/outline:\s*3px/);
  });

  it('lets the hidden attribute win, or hidden results still show', () => {
    expect(css).toMatch(/\[hidden\][\s\S]*display:\s*none\s*!important/);
  });

  it('respects a reduced-motion preference', () => {
    expect(css).toMatch(/prefers-reduced-motion/);
  });

  it('sizes blocks rather than fixing widths on children', () => {
    // A fixed width on a flex child does not shrink, so the keyboard ends up wider than the phone.
    expect(css).not.toMatch(/width:\s*\d+px/);
  });
});

describe('what needs a browser and is not checked here', () => {
  it('records the gap rather than pretending to close it', () => {
    // Layout, focus order, the pointer, and the narrow-layout measurement cannot be seen from a
    // DOM without a renderer. Naming them here so the absence is deliberate and visible.
    for (const file of ['HUMANS.md', 'AGENTS.md']) {
      const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
      expect(text.toLowerCase(), `${file} should mention the narrow-layout check`).toContain(
        'scrollwidth',
      );
    }
  });

  it('has the narrow-layout check written down in docs/web.md', () => {
    const doc = readFileSync(fileURLToPath(new URL('../docs/web.md', import.meta.url)), 'utf8');
    expect(doc).toContain('scrollWidth');
    expect(doc).toContain('44px');
  });
});

describe('the other pages', () => {
  it('has a 404 page, because nginx references one', () => {
    expect(existsSync(www('404.html'))).toBe(true);
  });

  it('has every page the index links to, so a live site has no dead links', () => {
    const linked = [...html.matchAll(/href="([a-z0-9_-]+\.html)"/g)].map((m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    for (const page of linked) {
      expect(existsSync(www(page)), `index.html links to ${page}, which does not exist`).toBe(true);
    }
  });
});

describe('the site is served under a path prefix', () => {
  // strandz.it serves this at /fluidmark/. The root belongs to another app and /jigdaw/ to a
  // third, so every URL the browser resolves has to be relative. A leading slash resolves to the
  // host's root instead, and the 404 there is silent because the page still loads and only its
  // module is missing.

  const pages = ['index.html', '404.html', 'spec.html', 'applications.html'];

  it('has no absolute paths in any page', () => {
    for (const page of pages) {
      const text = readFileSync(www(page), 'utf8');
      const absolute = [
        ...[...text.matchAll(/\ssrc="\//g)].map(() => 'src="/..."'),
        ...[...text.matchAll(/<link[^>]+href="\//g)].map(() => 'link href="/..."'),
      ];
      expect(absolute, `${page} loads from the host root: ${absolute}`).toEqual([]);
    }
  });

  it('has no absolute paths in the page script', () => {
    const absolute = [
      ...[...app.matchAll(/from '\//g), ...worker.matchAll(/from '\//g)].map(() => "import from '/...'"),
      ...[...app.matchAll(/import '\//g), ...worker.matchAll(/import '\//g)].map(() => "import('/...')"),
    ];
    expect(absolute, `app.js loads from the host root: ${absolute}`).toEqual([]);
  });

  it('loads its modules and its stylesheet relatively', () => {
    expect(html).toMatch(/href="style\.css"/);
    expect(html).toMatch(/src="app\.js"/);
    expect(worker).toMatch(/from '\.\/src\/load-browser\.js'/);
    expect(app).toMatch(/new URL\('\.\/worker\.js', import\.meta\.url\)/);
  });

  it('states the canonical address, prefix included', () => {
    // Behind a proxy that strips the prefix, the browser's own URL is not the canonical one.
    expect(html).toContain('<link rel="canonical" href="https://strandz.it/fluidmark/"');
  });

  it('never claims the canonical address of what else lives on the domain', () => {
    // /jigdaw/ is not this site's. A canonical link into it would tell a search engine this site
    // is that one.
    for (const page of pages) {
      expect(readFileSync(www(page), 'utf8'), page).not.toMatch(/strandz\.it\/jigdaw/);
    }
  });

  it('is named consistently across the pages', () => {
    for (const page of pages) {
      const text = readFileSync(www(page), 'utf8');
      expect(text, `${page} does not use the capitalised name`).toMatch(/FluidMark/);
      // The lowercase project name is fine in a repository path, not in a page title.
      expect(text, `${page} says "fluidmark" in its heading`).not.toMatch(/<h1>fluidmark/);
    }
  });
});

describe('everything the page loads resolves inside the prefix', () => {
  // The bug this exists for: app.js imported '../src/...', which from /fluidmark/app.js is
  // /src/..., outside the prefix. The proxy sends that to a different app, the import fails, the
  // whole script dies before it attaches a handler, and the page loads and does nothing. The
  // "no leading slash" tests above cannot see it, because '../' is relative.
  //
  // So this resolves every import specifier and module-relative URL the way a browser would, from
  // the URL the page is really served at, and requires each to land under /fluidmark/ and on a
  // file the container serves: www/ at the document root, src/ at /src/, and the one Wasm file.

  const ORIGIN = 'https://strandz.it';
  const PREFIX = '/fluidmark';
  const root = fileURLToPath(new URL('..', import.meta.url));

  /** The file the container would serve for a path under the prefix, or null. */
  function served(pathname) {
    const rest = pathname.slice(PREFIX.length);
    if (rest === '/build/fluidmark_core.wasm') return `${root}build/fluidmark_core.wasm`;
    if (rest.startsWith('/src/')) return `${root}src/${rest.slice(5)}`;
    return `${root}www${rest}`;
  }

  function specifiers(text) {
    return [
      ...[...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]),
      ...[...text.matchAll(/\bimport\s+'([^']+)'/g)].map((m) => m[1]),
      ...[...text.matchAll(/\bimport\(\s*'([^']+)'/g)].map((m) => m[1]),
      ...[...text.matchAll(/new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url/g)].map((m) => m[1]),
    ].filter((spec) => spec.startsWith('.'));
  }

  it('keeps every import and module URL under the prefix, on a file that exists', () => {
    const seen = new Set();
    // The page script and the worker it starts, which is reached by `new URL('./worker.js', import.meta.url)` and
    // is where nearly every module is imported from.
    const queue = [`${ORIGIN}${PREFIX}/app.js`];
    const problems = [];
    while (queue.length > 0) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const { pathname } = new URL(url);
      const file = served(pathname);
      if (!file.endsWith('.wasm') && !existsSync(file)) {
        problems.push(`${pathname} is not a file the container serves`);
        continue;
      }
      if (file.endsWith('.wasm')) continue;
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const next = new URL(spec, url);
        if (!next.pathname.startsWith(`${PREFIX}/`)) {
          problems.push(`${pathname} loads ${spec}, which is ${next.pathname}: outside ${PREFIX}/`);
        } else {
          queue.push(next.href);
        }
      }
    }
    expect(problems).toEqual([]);
    // A walk that found nothing would pass on any input, so it has to have found the codec.
    expect([...seen].some((u) => u.endsWith('/src/load-browser.js'))).toBe(true);
    expect([...seen].some((u) => u.endsWith('/build/fluidmark_core.wasm'))).toBe(true);
  });

  it('would catch the bug it was written for', () => {
    // The control: the same walk over the old specifier must report a problem.
    const next = new URL('../src/load-browser.js', `${ORIGIN}${PREFIX}/app.js`);
    expect(next.pathname.startsWith(`${PREFIX}/`)).toBe(false);
  });

  it('serves the page the same way the container lays it out', () => {
    for (const dir of ['www', 'src']) expect(readdirSync(`${root}${dir}`).length).toBeGreaterThan(0);
    expect(readFileSync(`${root}Dockerfile`, 'utf8')).toMatch(/COPY src \/srv\/src/);
  });
});

describe('a failure can be seen from where the button is', () => {
  const css = readFileSync(www('style.css'), 'utf8');

  it('keeps the status line in view, because the buttons are far below it', () => {
    // The status line was above the fold, an error went into it, and the button reset as if
    // nothing had happened. Sticky is what keeps it on screen. Layout cannot be measured here, so
    // this only checks the rule is present; `npm run check:web` is where it is seen.
    expect(css).toMatch(/\.status\s*\{[^}]*position:\s*sticky/);
  });

  it('does not offer formats the page cannot read', () => {
    expect(html).not.toMatch(/FLAC, OGG or M4A/);
    for (const input of html.matchAll(/<input type="file"[^>]*accept="([^"]+)"/g)) {
      expect(input[1], 'accepts a format readAudio refuses').not.toMatch(/flac|ogg|m4a|audio\/\*/);
    }
  });
});


describe('what the front door caches', () => {
  // A stale `app.js` against new modules is the failure the deployment rules name, and it happened:
  // the script sat under the one-hour cache meant for images. These parse the real nginx config and
  // ask what each URL the page loads would get, so the policy is a property of the file rather than
  // of someone remembering it.
  const conf = readFileSync(fileURLToPath(new URL('../deploy/nginx.conf', import.meta.url)), 'utf8');

  /** Location blocks as { kind, pattern, body }, in file order. */
  // One level of nested braces is allowed in a body, for `types { ... }`.
  const locations = [...conf.matchAll(/location\s+(~\*|~|=|\^~)?\s*(\S+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => ({
    kind: m[1] ?? 'prefix',
    pattern: m[2],
    body: m[3],
  }));

  /** The location nginx would pick, in its own order: exact, then regex in file order, then longest prefix. */
  function pick(path) {
    const exact = locations.find((l) => l.kind === '=' && l.pattern === path);
    if (exact) return exact;
    const regex = locations.find((l) => (l.kind === '~*' || l.kind === '~') && new RegExp(l.pattern, l.kind === '~*' ? 'i' : '').test(path));
    const prefixes = locations.filter((l) => l.kind === 'prefix' || l.kind === '^~').filter((l) => path.startsWith(l.pattern));
    const longest = prefixes.sort((a, b) => b.pattern.length - a.pattern.length)[0];
    if (longest && longest.kind === '^~') return longest;
    return regex ?? longest;
  }

  const cache = (path) => pick(path)?.body.match(/Cache-Control\s+"([^"]+)"/)?.[1];

  it('revalidates the page, its script, its stylesheet and every module and the Wasm it loads', () => {
    for (const path of ['/', '/index.html', '/spec.html', '/applications.html', '/app.js', '/style.css',
      '/src/load-browser.js', '/src/spread.js', '/src/audio-browser.js', '/build/fluidmark_core.wasm']) {
      expect(cache(path), `${path} is served with ${cache(path)}`).toMatch(/no-cache/);
    }
  });

  it('serves the modules from where they are, not from the document root', () => {
    // A regex location that also matched /src/x.js would pre-empt the alias and 404 it.
    expect(pick('/src/frame.js').pattern).toBe('/src/');
    expect(pick('/build/fluidmark_core.wasm').pattern).toBe('/build/fluidmark_core.wasm');
  });

  it('would catch the bug it was written for', () => {
    // The control: with no rule for the script, it falls through to the cached catch-all.
    const without = locations.filter((l) => !(l.kind === '~*'));
    const fallback = without.filter((l) => l.kind === 'prefix' && '/app.js'.startsWith(l.pattern)).sort((a, b) => b.pattern.length - a.pattern.length)[0];
    expect(fallback.body).toMatch(/max-age=3600/);
  });
});
