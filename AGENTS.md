# Agent Guidance

## Mission

Build fluidmark as a watermarking system for music. Mark a track with an identifier and get
that identifier back out of the marked file, where the mark is inaudible and survives
significant processing and degradation in both the time and frequency domains.

The payload is layered: a header declaring a mark is present, basic metadata, then an
identifying IRI, then arbitrary text.

There are three deliveries, in this order:

1. **A first pass following WebBeeps' strategy**: a payload written as audible tones.
   `docs/port.md` covers it. It is a baseline that makes the plumbing and the tests real, and
   it is not the goal.
2. **The steganographic layer**, which is the actual goal, and **native applications** that
   embed and extract. `docs/steganography.md` holds the survey and the reasoning.
3. **A VST plugin**, following the patterns of `~/github/downspout`, that takes text and
   generates a repeated MIDI pattern derived from it, usable as a bassline or melody on a
   dance track. Deferred to a later stage, and probably C++ with DPF.

What is built now is Rust to Wasm, driven by a browser front end and Node tools. The plugin
is the fourth host rather than the second, and nothing in the current work should assume it
is coming soon.

Keep five concerns separate: the payload and its encoding, the DSP, the carrier, the
embedding and detection, and the hosts (browser, Node tools, native apps, VST plugin).

```
  www/ (browser)   bin/ (node)   apps/ (native, later)   vst/ (DPF, later)
         \              |              |                       /
          \             |             |                      /
             src/              payload, codec, framing
  ============================ | ============================ one codec ====
                wasm/ (rust)                              the core: DSP
  ============================ | ============================ per-audio-block
                                   audio I/O
```

One codec. Every host drives the same code and none has a second implementation of it. A
feature that works on the site and not in a tool, or the reverse, is a defect.

**The core is Rust, behind a plain `extern "C"` ABI, emitting both a `staticlib` and Wasm from
the same source.** The browser and the Node tools use the `.wasm`; the C++ hosts, which are the
native applications and the plugin when it arrives, link the `.a` natively. No embedded Wasm
runtime and no component model. `docs/ffi.md` is the contract and the reasoning.

## The two inboxes

**Read [INBOX.md](INBOX.md) at the start of a session, and periodically during a long one.** It holds later thoughts that
have not been accommodated yet. Each item is worked into `TODO.md` or the relevant document, and struck from `INBOX.md`
once it has a home. An item left there is an intention nothing acts on.

**Record a tool that would help in [HUMANS.md](HUMANS.md).** Installing something is a person's action, so asking for it in
a chat message that scrolls away is how the ask gets lost. Say what the tool is, what it would let the work do that it
currently cannot, and what is being done in the meantime.

[HUMANS.md](HUMANS.md) is not a counterpart to this file: it is a short list of the actions only a person can take, the
blockers. Anything that is guidance rather than an action belongs here, and anything an agent can do itself does not belong
there at all.

## Non-negotiable rules

- Treat decoded audio as untrusted input. Validate at the boundary, surface errors, and fail gracefully rather than
  guessing: a false positive that claims a track is licensed when it is not is a worse failure than a miss.
- Never trust a decode. A payload recovered from audio is a hypothesis. Distinguish "the mark was found and the payload
  checksummed" from "something was found"; never report the second as the first.
- Never allocate inside an audio callback, and never grow `WebAssembly.Memory` from one. Growing memory detaches every
  existing view on it, so a held `Float32Array` becomes zero length and the symptom is silence rather than an exception.
- Preallocate every buffer before the processor reports ready. A processor that is not ready outputs silence; it does not
  throw and it is not audible.
- Anything that happens at a point in time is located by stream position, never by the index within the current block.
- Keep Rust/Wasm explicit about ownership: allocate once, hand out views, and say who frees.
- Keep the Node side and the browser side explicit. A module belongs to one side only, and the shared part is the codec,
  not a common module both sides happen to import.

## Repository conventions

- ES modules in JavaScript. Node 20 or later. npm. Scripts run from the repository root.
- TypeScript only as `.d.ts` declaration files for public interfaces. No TypeScript build.
- Vanilla JavaScript for structure, glue and orchestration. No framework.
- Rust for anything that loops over samples. The core, one crate, built two ways: a `staticlib` for the C++ hosts
  and a `wasm32-unknown-unknown` module for the browser and Node tools. `docs/ffi.md`.
- Never let a panic cross the boundary. `panic = "abort"` in release, and errors return a code.
- Vitest, with `tests/` mirroring `src/` exactly. Cover valid, invalid and failure cases.
- C++ and CMake are for the later plugin and native stages, following `~/github/downspout`: a portable core with no
  plugin-framework dependency, tested with CTest. Not in the current work.
- Small modules with explicit dependencies and dependency injection rather than globals.
- Every source file opens with a path comment, as `// src/codec/Ascii.js`, and every Rust file as `//! src/dsp/goertzel.rs`.
- Comments describe intent where it is not obvious, or an unusual API. Not effects.
- Prefer deterministic offline tests. A decode of a fixed file is reproducible; a live microphone is not.
- A source file past about 400 lines is worth a look and past about 600 usually wants splitting, along a seam that already
  exists rather than by line count. Keep the old module as the front door and re-export, so callers do not change.
- Numeric constants that both sides must agree on are declared once and imported by both. A tone table written twice is two
  tone tables.

## Porting rules

`reference/WebBeep` is Danny Ayers' own earlier work, and fluidmark is a port and an extension of it. Reuse from it
directly: read it, copy from it, refactor it in place if that is clearer than starting over. Two things it still asks of
the port:

- Port what the reference does, including its fragile parts, and record each fragile point rather than quietly repairing
  it. A port that silently fixes a bug cannot be checked against the reference, and the fragile parts are the ones most
  likely to be wrong later.
- Where the reference is self-contradictory or its spec is a TODO, `docs/port.md` records the reading taken. If a reading
  turns out wrong, correct the document.
- Compare against the reference's own output, never against the port's own output. Self-comparison passes for a port that
  is wrong in the same way twice. Once the port is further along, comparing against the reference is what catches a change
  that was not meant.
- `reference/WebBeep/notes/` holds what the author already found out the hard way, including failed approaches and
  parameter searches. Read it before choosing an algorithm; several of the options listed there were already tried.

## Change workflow

Add newly identified work items to `TODO.md`. Remove each item when its
implementation and verification are complete.

Before editing:

1. Inspect the relevant model, Wasm boundary, pipeline, and test contracts.
2. Identify ownership and lifecycle constraints (who owns a buffer, when it is allocated, who frees it).
3. Keep the change within the smallest affected subsystem.

When implementing:

1. Add or update the public interface first.
2. Add focused unit tests for valid, invalid, and failure cases.
3. Keep the Rust, JavaScript and I/O responsibilities explicit.
4. Document breaking changes and migration implications.
5. Log mistakes in [MISTAKES.md](MISTAKES.md) (what happened, root cause, prevention), newest first.

Before handoff, run the program itself as well as the narrowest relevant tests and a type check or build. The test suite
does not catch a broken import, a miswired startup, or an entry point that exits 0 having produced nothing. Report any
environment-dependent tests (browser, display, device, network) separately.

Review `TODO.md` periodically and revise it. Promote anything systematic from [MISTAKES.md](MISTAKES.md) into this file.

## Steganography rules

The real goal, covered in `docs/steganography.md`. These are the ones that will be easy to
break by accident.

- **SNR is not a proxy for audibility.** It is a proxy for signal difference, which is a
  different thing. Objective metrics and a listening verdict are separate measurements, and
  only the second one decides whether the mark is inaudible.
- **Build the attack harness before the scheme.** A harness written after the algorithm
  exists will have been written to prove the algorithm works. The attack list is the
  specification: transcode, resample, gain, dither, filter, time shift, crop, stereo to mono,
  and a DAW render cycle. Each gets a measured figure.
- **A decoder must be able to say "no mark here".** Without a header to recognise, an
  unmarked file yields a plausible wrong answer, and a false positive on an unmarked track is
  the worst failure this project has.
- **Interleaving matters as much as the error-correcting code.** Transcoding damage arrives in
  one band and destroys every symbol in it unless the payload is spread out first.
- **The keyed sequence is what makes the mark undetectable, not the payload.** An unkeyed
  scheme is found by anyone who looks, and `reference/perplexity-pointers.md` has a paper on
  exactly that.
- **"No psychoacoustic effect" is not the same as "inaudible by construction".** The brief
  asks for a plugin that does not alter what the music sounds like; that is a target to be
  measured against, not a property to be assumed from writing audio.

## Audio rules

- A measurement without a positive control measures the default. Print how many samples were taken and check the calls
  returned what they claim, before believing a figure in either direction.
- Report level, sample rate and channel count with any accuracy figure. Accuracy at full scale says nothing about accuracy
  at -30 dBFS, and watermarking happens wherever the programme material happens to be.
- Interference tests are part of the work, not an extra. The list is in `reference/WebBeep/notes/tests.txt`: white noise,
  pink noise, harmonic distortion, reverb, clipping, and a lossy codec round trip.
- An inaudible mark needs a stated audibility criterion and a test that checks it. Without one, "inaudible" is a claim.

## VST plugin rules

The plugin is a later stage, and these are held for it rather than applied now. It will
follow the patterns of `~/github/downspout`, which are worth reading before writing any of it:
a portable C++ core with no plugin-framework dependency, a thin DPF wrapper, a custom NanoVG
UI, and deterministic tests over the core that run without a DAW.

- **The payload encoding is not the plugin's business.** The plugin's job is to take text and
  emit a musical event stream derived from it. Where that maps to pitches and timings is the
  MIDI carrier's decision, and it belongs in the core so it can be tested without the framework.
- **Never block the audio callback.** Not for MIDI generation, not for encoding, not for a
  parameter change. Generate on a worker and hand the audio thread a finished buffer.
- **The mark must not change the sound beyond being the music.** A plugin in a mastering
  chain is trusted with someone's finished track; anything audible it adds is a defect, not a
  feature.
- **The plugin embeds, the native apps extract.** A user puts this in a mastering chain and
  never decodes from it. Do not put a detector in the plugin because it seems symmetric.
- **The generated pattern must be musically plausible**, because the plan is a bassline or
  melody someone would keep. A pattern derived from text by hashing is not that, and
  `docs/steganography.md` gives the constrained-choices approach.
- **Parameter changes must not change an already-rendered note.** A DAW re-evaluates on a
  parameter change, and if the pattern shifts under a note already sounding, the output is
  not deterministic.
- **VST3 metadata follows downspout's normalisation** (creator `danja`, group `Downspout`),
  since these plugins are meant to sit alongside them.
- **The core stays callable from C++**, which is already arranged: the plugin links
  `libfluidmark_core.a` and calls the same `extern "C"` functions the browser calls, so nothing
  in the plugin needs to know about Wasm. See `docs/ffi.md`.

## Interface rules

There is a browser front end, ported from `reference/WebBeep/www`, and it goes online with the same functionality. That
previous version was a Jetty servlet app: a form POST to `/encode` and a multipart upload to `/decode`, with the codec
running on the server in Java and MP3 made by shelling out to `lame`. The port keeps the two operations and the pages, and
does not keep the servlet app. See `docs/web.md`.

- Encode and decode both run in the page, in Wasm. Nothing about a watermark operation needs a server: the input is a file
  the user already has, the output is a file they want. A server round trip adds an upload of the whole track, a privacy
  problem for a tool whose users are trying to mark their own music, and a failure mode that does not exist otherwise.
- Follow [WCAG 2.2](https://www.w3.org/TR/WCAG22/) at AA. Make everything keyboard reachable before pointer, and keep the
  focus indicator visible against the panel background. Do not signal state by colour alone.
- Leave out a control nobody can use rather than showing it disabled. A disabled control looks identical to an enabled one
  under a screen reader and under the pointer, so nothing about interacting with it says whether it does anything.
- Works on a phone: a `viewport` meta tag, one column below 720px, no horizontal scrolling, touch targets at least 44px,
  and font size at least 16px on any text input, because iOS zooms the page in when a smaller one takes focus.
- Measure a narrow layout rather than reasoning about it. Load the page into a narrow iframe in a real browser and compare
  `documentElement.scrollWidth` with `innerWidth`. The tests cannot see layout, because there is no layout in a DOM without
  a renderer, and `clientWidth` includes padding while an element outside the document measures zero.
- The same is true of the pointer and the focus, and it is easier to miss because the code looks testable. A DOM without a
  renderer has no pointer capture to fail and no `activeElement` to lose. Drive the real thing.
- A file input is not a usable upload control on its own: the chosen file's name and size are announced by nothing on some
  browsers, and a decode that returns an empty result must say the mark was not found rather than showing an empty box.

## Native application rules

The native applications embed and extract. They are the delivery that works on a finished
master without a DAW open, so they are where the system has to be trustworthy.

- **One core, every host.** The embed and detect logic is the Rust core, and the browser, the Node tools, the native
  applications and the plugin all drive that same core rather than each having their own. A host reimplementing detection
  is the single most expensive mistake available here, because its results then differ from every other host's and nobody
  finds out until a mark fails to verify.
- **Verify before claiming.** An extractor that returns a payload has found a candidate, not a
  verified mark. Say which, and say what the confidence was.
- **The extractor takes a file a user chose.** It is untrusted input, it may be enormous, and
  it may be nothing like what the embedder wrote. Bound the work and fail clearly.
- **A false positive is the worst outcome available.** Claiming a track carries an IRI it does
  not carry is a real failure with real consequences. When the detector is unsure, the right
  answer is to report nothing.

## Deployment rules

- The site goes online with the same functionality as the previous version. That is a commitment, so it needs a check that
  notices it breaking: every page and both operations reachable by a real request, not only by a unit test of the handler.
- A tool whose output is a downloaded file needs its output to be a real file, not a blob URL that dies with the page.
- The Wasm build is fetched by the page, so a stale cached page against a new Wasm build is a real deployment failure with
  no error in the console. Decide the cache policy before the first deploy, not after.
- Everything a page needs is served from the origin. No CDN script, no third-party embed, nothing that breaks when offline
  or when a third party is down.

## Failures worth naming in advance

MISTAKES.md holds the project's own mistakes, newest first, and opens with lessons carried over from sibling repositories
because they are the ones most likely to recur. Each says what would notice it happening. Three recur across bugs that
otherwise share nothing:

**A guard is only as wide as the list it walks.** A check can be right about the rule and wrong about the population: one
that reads only committed files ignores all new code, one that reads only entities with routes ignores the rest, one that
checks a config list from inside a suite that list governs checks itself. When adding a guard, write down what it walks and
ask what is outside that set. Corollary: a guard must not depend on the thing it guards, and the way to find out is to
break the thing on purpose and watch the guard go red.

**A fake more permissive than the real thing turns a specification error into a passing test.** A stand-in for a platform
API is worth having only where it refuses what the real one refuses. This matters more here than elsewhere, because the
natural fake for this project is a synthetic tone where a real track should be, and a decoder that recovers a payload from
a clean synthetic tone has been tested on nothing.

**A change in one file usually needs a second file to change with it, and nothing connects them.** Find what else has to
agree with a new dependency on a path, a value or a list, and write the test that binds them. In a watermark the obvious
case is the tone table and the pitch finder, which must agree on every frequency, and the sample rate, which everything
computes against.

## Diagnosing problems

1. Reproduce with the smallest input that still fails, and keep it as a test.
2. A decode that returns nothing: check framing before checking the payload. Where the decoder thinks the mark starts is
   a separate question from what it read, and conflating them wastes the time.
3. A decode that returns a wrong payload: check the pitch finder against a single synthesised tone at a known frequency
   before touching the codec. Most decode bugs are a DSP bug reported as a codec bug.
4. Use existing diagnostics (logs, test output, a spectrum plot) before adding new instrumentation.
5. Confirm the fix with a test that would have failed before the change.

## Notes

- `reference/WebBeep` is Danny Ayers' own earlier work, kept in the repository to port from. Reuse from it freely, and
  note in a commit when fluidmark's behaviour deliberately differs from it.
- `reference/perplexity-pointers.md` is the steganography survey, with ten papers and a recommended research path.
- `docs/port.md` holds the reading taken of each ambiguous part of the reference. `docs/steganography.md` holds the carrier
  reasoning and the attack list. `docs/web.md` holds the front end. `docs/initial-thoughts.md` is the original brief.
