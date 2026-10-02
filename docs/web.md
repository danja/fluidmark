# The web front end

A browser front end ported from `reference/WebBeep/www`, going online with the same
functionality. This document says what that previous version was, what the port keeps, and
what changes.

## What the previous version was

Read from `reference/WebBeep/www/` and the Jetty handlers beside it.

Six static HTML pages: `index.html` (the working page), `spec.html`, `implementation.html`,
`applications.html` (with anchors for broadcast, musicians, web designers and developers),
`template.html`, and a `doap.xml` description. Three stylesheets in `css/`, one empty
`js/curvycorners.js`, images, fonts, and an `audio/` directory holding the MP3s the service
had generated.

Two forms on the index page, and they are the whole of the functionality:

- **Make Beeps.** A text field (`inputText`, up to 63 characters, more split by
  `TextSplitter`), POST to `/encode`. `EncodeHandler` runs `DefaultEncoder` in Java, writes
  a WAV, shells out to `lame --abr 64`, and returns `index.html` as a string with
  `<p>Try it out</p>` replaced by a link to the generated MP3.
- **Decode Beeps.** A file input, multipart POST to `/decode`. `DecodeHandler` reads the
  upload, converts it back with `lame --decode`, and returns the recovered text.

So the previous version was a **server-side servlet app**, not a browser app. The page held
two forms and nothing else; every bit of the codec ran in Java on the server, and the browser
never saw a sample.

## What the port keeps

Every page, both operations, and the workflow they describe. Same two operations, same two
inputs, same outputs: a downloadable audio file from encode, recovered text from decode. The
applications pages and the spec page are prose and port as prose, with the spec revised to
describe what the port actually does.

The character limit and the text splitting carry over as behaviour. Whether 63 characters is
still the right limit is a separate question (`TODO.md`).

## What changes

**The codec runs in the page.** Not a copy of the codec in JavaScript for the browser and
another in Rust for Node: one codec, driven by both hosts. This is the main structural
difference from the previous version, and it is why the Wasm work is not optional.

Three consequences follow, and all three are reasons to do it this way:

- **No upload.** A user marking their own music should not have to upload the track to a
  server to get it back marked. The previous design made that unavoidable.
- **It works offline and cannot break.** No server process, no `lame`, no disk. The previous
  version needed a Java runtime and an encoder binary on the host, and its own README
  installs both.
- **The same code is tested by the same tests.** A browser-only implementation would be
  verified differently from the Node one, and would drift from it.

What is lost: there is no server-side log of what was encoded, no shared audio directory, and
no MP3 by default. Losing those is the point. MP3 in particular was the previous version's
own robustness test rather than a feature (`notes/tests.txt` lists it), so it belongs in
the test suite and not in the page.

**The page is built as a page.** The previous one is a static file with a string
`replaceAll` done on it by a servlet handler. The port does the replacement in the browser,
where the state already is, and a page whose content is rewritten by string substitution in
a server handler does not survive a content change.

**Encode outputs WAV, not MP3.** This is a change, and the previous site did the opposite
by default: `EncodeHandler` wrote a WAV, shelled out to `lame --abr 64`, and linked the
resulting MP3. So a user marking a track got back a 64 kbps lossy file, which is roughly
the same interference level as the lossy round trip in `notes/tests.txt`. The port hands
back the WAV it made. Two reasons: lossy compression throws away signal the mark depends
on, and there is no `lame` in the browser. The old behaviour is a robustness test rather
than a feature, and it belongs in the test suite where `TODO.md` already has it.

This does not mean MP3 is dropped from the project. It is the *decode* direction that still
needs it: the files people already hold from the old site are MP3s, so accepting MP3 is a
compatibility requirement, not a new feature.

**Accessibility is a requirement, not a retrofit.** The previous version's markup is from
about 2011: no `viewport` meta tag, image-only buttons (`images/button-left-100.png` and
`button-right-100.png` as the visible affordances for each form), and form controls with no
labels beyond adjacent text. The port needs to meet WCAG 2.2 AA as new work, per `AGENTS.md`.

## The pages

| Page | What it is | Priority |
|---|---|---|
| `index.html` | Make Beeps and Decode Beeps, the whole tool | First |
| `spec.html` | The format spec, revised to match the port | Second |
| `implementation.html` | How it works, revised | Second |
| `applications.html` | Who it is for | Port as prose |
| `template.html` | Layout the others share | With the first |

## How to check the front end

`npm run docker:check` builds the image, serves it, and drives the real page in a real browser.

`tests/web.test.js` checks the markup: that every id `app.js` reaches for exists, that the page
loads nothing from a third party, that every control has a label, and that the stylesheet keeps the
touch-target and font-size rules. Those catch the changes that break the page for a person while
every other test still passes.

What it cannot check is layout, focus order, or the pointer, because a DOM without a renderer has
none of them. Two specific measurements, both in `HUMANS.md` because they need a real browser:

- **Narrow layout.** At 360px, `documentElement.scrollWidth` should equal `innerWidth`. Not
  `clientWidth`, which includes padding. Every target at least 44px, the text input at least 16px.
- **Focus and pointer.** Tab through both forms and count the stops. A drag that stops at the edge
  of its element, and a control that can be nudged once by keyboard, both pass every unit test,
  because there is no pointer capture to fail and no `activeElement` to lose.

**Deployment check**, run against the container rather than the source tree:

```sh
docker build -t fluidmark:local .
docker run --rm -p 8080:8080 fluidmark:local &
curl -sI http://127.0.0.1:8080/ | head -1
curl -sI http://127.0.0.1:8080/build/fluidmark_core.wasm | grep -i content-type
curl -s  http://127.0.0.1:8080/healthz
```

The content-type check is the one that matters: `application/wasm` or the browser falls back to
compiling the whole module as an `ArrayBuffer`, which works, is slower, and says nothing about it.

**Browser check.** `www/browser-check.js` drives the page in headless Chrome over the DevTools
protocol, with no browser-automation dependency, and reports sixteen things: the Wasm module
loading over HTTP with the right content type, both schemes round-tripping *in the page*, unmarked
audio not being reported as marked, and then the layout measurements that a DOM without a
renderer cannot make.

It sets the viewport to 360px rather than the headless default of about 780, which is the whole
point: a layout with a fixed-width child looks correct at 780 and is unusable on a phone. Measured
at 360px, `scrollWidth` equals `innerWidth`, every visible target is at least 44px, and every text
input computes to 16px.

Two things it deliberately does not do, both in `HUMANS.md`: it does not press real keys (scripted
focus shows whether an element is focusable, not whether the tab order is right), and it has no
screen reader.

## Notes for whoever builds this

- **AudioWorklet is not needed for either operation.** Both are file in, file out, and take
  as long as they take. A progress indicator over a few seconds is enough, and a long
  operation needs a cancel, because a four-minute track at full decode cost is not instant.
- **Where the Wasm boundary falls for decode matters.** Decoding a whole file at once is
  simplest and allocates for the whole file. Decoding in blocks in a worker is what keeps the
  page responsive and is what makes progress and cancel possible. Decide which, because it
  changes the buffer ownership rules in `AGENTS.md` from "one file" to "one block".
- **The uploaded file may be MP3, not WAV.** The previous version produced MP3s, so that is
  what people hold and what they will upload. Decode needs a lossy decoder in the page, which
  is a real piece of work (WebCodecs `AudioDecoder` where available, a WASM decoder otherwise)
  and is not covered by the WAV codec in the port plan. Encode does not need one: it writes
  WAV.
- **Decode must distinguish "no mark here" from "the mark was empty".** A page that returns
  an empty string for both teaches a user that the tool is broken. Report the three cases:
  a payload, no mark found, and found-but-damaged.
- **A file input is announced badly.** Show the chosen file's name and size next to it, in
  text, because on some browsers the input announces neither.
- **The old URLs were `webbeep.it`.** Whether the new site keeps that name or gets a new one
  is a decision, and it affects every canonical link and the `doap.xml`.