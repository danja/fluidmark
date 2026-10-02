# fluidmark

Watermarking for music. Mark a track with an identifier, and get that identifier back out
of the marked file, where the mark is inaudible and survives significant processing and
degradation in both the time and frequency domains.

The plan is in `TODO.md`, the guidance in `AGENTS.md`. What is built is small and real: the
Rust core, its C ABI, and the boundary tests.

## The core

One Rust crate, two artifacts, one set of `extern "C"` functions:

```
wasm/     the core: DSP behind a C ABI, built as libfluidmark_core.a and .wasm
src/      the JavaScript wrapper: typed arrays instead of pointers, real errors
bin/      Node tools
tests/    Vitest, mirroring src/
```

`npm test` builds the core, runs the Rust tests, runs a C++ link check against the static
library, then the Vitest suite. `docs/ffi.md` is the boundary contract.

```sh
npm run build
node bin/mark.js --in track.wav --payload "http://example.org/" --out marked.wav
node bin/mark.js --in marked.wav --read
```

The first pass works, and it is checked against the reference implementation's own output rather
than against itself: it reads `reference/WebBeep/data/beeps.wav` back as `abc`, and five of the
six MP3s the live service produced give their payloads. `docs/port.md` has the numbers, including
the one that fails and why.

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