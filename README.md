# fluidmark

Watermarking for music. Mark a track with an identifier, and get that identifier back out
of the marked file, where the mark is inaudible and survives significant processing and
degradation in both the time and frequency domains.

The plan is in `TODO.md`, the guidance in `AGENTS.md`, and where things stand against the brief is in
`docs/steganography.md`, which has the measured tables.

What exists: a spread-spectrum watermark that reads back exactly after gain changes, dither, moderate noise,
filtering, resampling, a crop, a time shift, a fold to mono, MP3 down to 32 kbit/s, and speed changes and clock
drift of up to several percent, on real stereo music. It takes WAV and MP3, keeps the channels and the bit depth,
and runs entirely in the browser. What does not exist yet: confirmation by listening that it is inaudible at any
level (that is a person, `HUMANS.md`), any measurement against someone trying to remove it, and the native
applications and the VST plugin.

## The core

One Rust crate, two artifacts, one set of `extern "C"` functions:

```
wasm/     the core: DSP behind a C ABI, built as libfluidmark_core.a and .wasm
src/      the JavaScript: the wrapper, the framing, the WAV and MP3 code, the attack list
bin/      Node tools
www/      the browser front end
tests/    Vitest, mirroring src/
deploy/   nginx configuration
```

`npm test` builds the core, runs the Rust tests, runs a C++ link check against the static
library, then the Vitest suite. `docs/ffi.md` is the boundary contract.

```sh
npm run build
node bin/mark.js --in track.wav --payload "http://example.org/" --out marked.wav --key "a phrase"
node bin/mark.js --in marked.wav --read --key "a phrase"
node bin/attack.js --in track.wav --payload "http://example.org/" --scheme spread   # one file, every attack
node bin/corpus.js --dir ~/Music/album --strength -20                               # a whole directory
node bin/make-track.js --out track.wav                                              # a synthetic test track
```

`mark.js` takes WAV directly and anything else through ffmpeg. `--scheme tones` is the original audible
scheme from the reference. `attack.js` and `corpus.js` print what survives and what does not, including
the rows that do not, and a false positive on an unmarked track is their exit status.

The site is a container: nginx serving static files, with the Wasm module built in an earlier
stage, so the running image has no Node and no Rust in it. On the server that runs it,
`npm run deploy` pulls, builds, checks the new image on a spare port, swaps it in and rolls back
on failure (`HUMANS.md`). `npm run check:web` drives the real page in headless Chrome.

```sh
docker build -t fluidmark .
docker run --rm -p 8080:8080 fluidmark
```

Three schemes, deliberately kept apart. The spread-spectrum watermark is the real one. The audible tone codec is
the first pass ported from WebBeeps, kept so that old files read and as the baseline the harness was built
against. Keyed least-significant-bit embedding survives nothing in the attack list, which is the point: it is
the control that shows the harness measures something.

The tone codec is checked against the reference implementation's own output rather than against itself: it
reads `reference/WebBeep/data/beeps.wav` back as `abc`, and five of the six MP3s the live service produced give
their payloads. `docs/port.md` has the numbers, including the one that fails and why.

## The payload

A header declaring that a mark is present, then basic metadata, then an identifying IRI,
then arbitrary text. The IRI is the point of the system: it says where the recording came
from, so it should be the part that is always present and always reliable.

## The three deliveries

1. **A first pass, audible.** Ported from WebBeeps, which writes a payload as tones. A
   baseline that makes the plumbing and the tests real. `docs/port.md`.
2. **The steganographic layer and native applications.** The actual goal: an inaudible mark,
   embedded and extracted, surviving transcoding, filtering, gain, resampling and the rest.
   `docs/steganography.md`.
3. **A VST plugin**, later, following the patterns of `~/github/downspout`: text in, a
   repeated MIDI pattern out, for use as a bassline or melody. Probably C++ with DPF.

What is being built now is Rust compiled to Wasm, driven by a browser front end and Node
tools. A browser front end goes online with the same functionality as the previous site, and
runs the codec in the page rather than on a server. `docs/web.md`.

## What exists so far

- `reference/WebBeep`, Danny Ayers' earlier Java implementation of audible tone
  watermarking. fluidmark ports and extends it, so this is a source to work from rather
  than a read-only exhibit: its `notes/` also hold the failed approaches and parameter
  searches worth not repeating.
- `reference/perplexity-pointers.md`, the steganography survey: ten papers with a strategy
  map and a recommended research path.
- `docs/initial-thoughts.md`, the original brief.
- `docs/port.md`, the first pass and where the reference falls short of the goal.
- `docs/steganography.md`, the carrier choice, the attack list, and how results are judged.
- `docs/web.md`, the browser front end.
- `docs/ffi.md`, the boundary between the Rust core and its hosts.
- `AGENTS.md`, `TODO.md`, `INBOX.md`, `HUMANS.md`, `MISTAKES.md`, the working guidance.
