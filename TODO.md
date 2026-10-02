# TODO

What the project needs. Remove an item when its implementation and verification are complete, and keep whatever it left
undone as an item of its own. Review periodically. What is built is in `git log`, and mistakes are in [MISTAKES.md](MISTAKES.md).

Later thoughts that have not been accommodated yet go in [INBOX.md](INBOX.md). Actions only a person can take are in
[HUMANS.md](HUMANS.md). The three deliveries are in [docs/port.md](docs/port.md), [docs/steganography.md](docs/steganography.md)
and [docs/web.md](docs/web.md).

Nothing has been started. The items below are ordered so that each unlocks the next.

## Decisions taken

Recorded so they are not relitigated, and so a later reader can see what was chosen and why.

- **The core is Rust, behind a plain `extern "C"` ABI**, emitting a `staticlib` and a Wasm module from one source.
  The browser and Node tools use the `.wasm`; the C++ hosts link the `.a` natively.
- **The VST plugin is a later stage**, and will probably be C++ with DPF, following `~/github/downspout`. The ABI already
  accommodates it, so arriving late costs nothing. Writing the DSP twice is not worth considering.
- **The delivery order** is the WebBeeps-style first pass, then the steganographic layer and native apps, then the plugin.
  The argument for the first pass coming first is in `docs/steganography.md`: it makes the attack harness and the plumbing
  real, which is what the steganographic work needs and does not otherwise have.
- **The FFI boundary is a plain `extern "C"` ABI**, with the Rust crate emitting both a `staticlib` and a Wasm module from
  one source. The browser and Node use the `.wasm`; the C++ hosts link the `.a`. No embedded Wasm runtime and no
  component model. Verified on this machine before being written down: one crate produced both artifacts, C++ linked the
  `.a` and called the Goertzel function correctly, and the same three symbols called from Node matched a JavaScript
  reference to eight decimal places. `docs/ffi.md` has the contract and the reasoning, including why the component model
  was rejected: a WIT file and a codegen step for a benefit that matters least to a DSP core passing `f32` buffers.

## Decisions still open

- [ ] **The payload format**, which the brief gives as layered: header declaring a mark is present, metadata, an
      identifying IRI, then arbitrary text. Undecided: byte layout, version field, and what a checksum strong enough to
      catch a transposition looks like. The reference's byte-sum modulo 128 does not.
- [ ] **The false-positive policy.** What does the detector do when it finds tone-like or noise-like structure that
      is not a mark? This most affects whether the system is usable, and it needs stating before the detector is written
      rather than after it misfires on an unmarked track.
- [ ] **What "inaudible" means as a number.** A target, a measurement method, and a threshold. The brief asks for
      a plugin with "no psychoacoustic effect", which is a target and not a property. Without a criterion, inaudible is a
      claim with nothing behind it.
- [ ] **The supported formats and sample rates.** The reference is mono 16-bit 22050 Hz throughout. Real music is
      stereo, is 44.1 or 48 kHz, and gets resampled in the wild, which is where a tone-based mark breaks first.
- [ ] **The site's name and URL.** The previous version was `webbeep.it`. Keeping it or choosing a new one affects
      every canonical link and the `doap.xml`, and it is cheaper to decide before there are pages than after.
- [ ] **The Wasm boundary for a long decode**: whole file at once, or blocks in a worker. Blocks are what make a
      progress indicator and a cancel possible, and they change the buffer ownership rules from one file to one block.

## Foundations

- [x] **Set up the repository.** `package.json`, `src/`, `wasm/`, `bin/`, `tests/` mirroring `src/`, Vitest, and
      `wasm/` as a Rust crate emitting a `staticlib` and a Wasm module. `npm test` builds the core, runs the Rust tests,
      runs the C++ link check, then the Vitest suite. Done 2026-10-02.
- [x] **WASM boundary tests**, before any DSP: allocation, a tracked length and capacity that must not diverge from the
      core's copy, refusals, and the `memory.grow` detachment in `tests/memory.test.js`. Both real bugs found so far came
      from this: a heap overflow in `core_scratch_new`, and a stale-view hazard.
- [x] **Typed `.d.ts` declarations** for the wrapper, in `src/wasm.d.ts`.
- [x] **Keep the core callable from C++.** `wasm/tests/link_check.cpp` compiles against the real
      `libfluidmark_core.a`, calls the same functions the browser does, and gets an identical Goertzel result. Run by
      `npm run test:native`.
- [ ] **Generate the C header from the Rust declarations** (`cbindgen`), so a C++ host does not hand-write the signatures.
      Found the friction for real: `core_buffer_data` was declared `int32_t` in the link check when it returns a pointer,
      and the program segfaulted rather than failing to compile. The Rust signature is the truth; the header must come
      from it or the two will drift.
- [ ] **A watermark payload in a buffer, end to end through the boundary**, which is the first thing that is not a
      boundary test. `Tone` and `Chunks` from the reference come first.

## Delivery 1: the WebBeeps first pass

A baseline that makes the plumbing real. In dependency order, each piece ported as the reference does it, fragile parts
included, with the reading taken recorded in `docs/port.md`.

- [x] **The core and its C ABI.** Rust crate emitting a `staticlib` and a Wasm module, versioned buffers with a tracked
      length and capacity, scratch for out-parameters, error codes rather than panics. `docs/ffi.md`.
- [x] **Tone tables and constants**, in `wasm/src/tables.rs`, carrying the `data/config.xml` values rather than the
      `Constants.java` ones, because the latter do not round trip.
- [x] **Goertzel power**, matching `reference/WebBeep`'s recurrence and power formula exactly.
- [x] **The pitch finder**, reporting distinct frequencies, which is what the reference's `HashSet` amounts to and what
      its duplicated table entries make load bearing.
- [x] **The signal processors**: normalise, envelope, crop, chunk. The ones the working configuration switches off are
      ported too, since they are part of the reference.
- [x] **The text codec**: bytes to dual tones and back, the envelope, the padding.
- [x] **The end-to-end round trip**, 94 of 95 printable ASCII characters alone, and silence and noise decoding to nothing.
- [x] **The JavaScript wrapper and the payload layer**, with the checksum verifying rather than merely logging.
- [x] **WAV read and write**, mono 16-bit, walking the chunk list.
- [x] **`bin/mark.js`**, marking and reading a file.
- [x] **Cross-implementation validation.** Reading `data/beeps.wav` gives `abc`, and five of the six MP3s the live
      service produced give their payloads. `tests/reference.test.js`.
- [ ] **The filters and the compressor.** High-pass and two low-pass FIRs plus the compressor, all off in the
      configuration that works, so not on the critical path and the largest piece of the reference still missing.
- [ ] **WAV writing from the CLI is done; WAV reading of anything but 16-bit mono is not.** A stereo or 24-bit file is
      refused rather than half-read, which is deliberate, but a real tool needs to handle what people actually have.
- [ ] **A lossy decoder in Node**, so the CLI can read an MP3 without shelling out to ffmpeg. The browser side needs the
      same thing and it is in the front end section.

## Delivery 2: the steganographic layer and the native apps

The actual goal. `docs/steganography.md` has the carrier reasoning, the attack list and the
measured baseline.

- [x] **The payload frame**: magic, version, flags, length, CRC-16, so a reader can say "no mark
      here" rather than reporting whatever bytes it read. `wasm/src/frame.rs` and `src/frame.js`,
      mirrored, with a test that they agree.
- [x] **The attack harness**, before the scheme it measures. 17 attacks in `src/attacks.js` and
      `wasm/src/attack.rs`: gain, dither, white and pink noise, low-pass, high-pass, resampling,
      time shift and crop, plus lossy transcoding through ffmpeg when it is there.
- [x] **The LSB baseline**, as the control the harness is calibrated against. Keyed positions, one
      bit per sample in the 16-bit representation.
- [x] **The measured baseline**, in `docs/steganography.md`. Every attack in the brief's list leaves
      the payload unreadable at a bit error rate near 50%, which is random.
- [x] **A false-positive measurement**: 20 noise buffers, none reported as carrying a mark.
- [x] **`bin/attack.js`**, which prints the table and can write the marked file.
- [ ] **Spread spectrum in a transform domain.** Keyed spreading sequence, a sync word the decoder
      can find, a length field, FEC and interleaving. The bar is in the table in
      `docs/steganography.md`: `resample to 48 kHz` and `mp3 64k` must beat 50%.
- [ ] **Synchronisation.** LSB has no sync word, so a reader has to be told the payload's length.
      This is why `extract` requires `payloadBytes` and why a real scheme cannot.
- [ ] **Forward error correction and interleaving.** So a burst of damage costs symbols rather than
      the message. Transcoding damage arrives in one band.
- [ ] **The psychoacoustic layer**, so the mark sits under a masking threshold rather than at a
      fixed level. Needs the audibility criterion from the decisions list first.
- [ ] **The native applications**: embed and extract, over the same core the browser and the tools
      use.
- [ ] **Stereo.** Everything so far is mono, and real music is not.

## Delivery 3: the VST plugin, later

Not started, and deliberately so. C++ with DPF, following `~/github/downspout`: a portable core with no
plugin-framework dependency, a thin DPF wrapper, a custom NanoVG UI, deterministic tests that run without a DAW. Read
`~/github/downspout/docs/porting.md` first.

- [ ] **Link `libfluidmark_core.a` into the plugin.** Nothing to design: the ABI already accommodates it. Add the Rust
      build to the plugin's CMake, link the staticlib, and call the same `extern "C"` functions the browser calls.
- [ ] **The MIDI carrier design**, before any code. How text becomes musically plausible notes, using the
      constrained-choices approach rather than hashing text into pitches. This is the piece with the most open questions
      and the one `docs/steganography.md` flags as needing a model rather than a mapping.
- [ ] **The core**, taking text and emitting a repeating pattern, with tests that run without a DAW.
- [ ] **The DPF wrapper and the NanoVG UI**: text in, and the pattern visible so the user can tell it is music.
- [ ] **The plugin installed and tried in a DAW**, which is a person (`HUMANS.md`).
- [ ] **Metadata normalised to downspout's convention**, so the two sit together without looking like different projects.

## Verification

Per delivery, so that each is held to its own standard.

- [ ] **Round trip** on the reference's test material, compared against the reference's output.
- [ ] **Interference suite**, over the list in `reference/WebBeep/notes/tests.txt`: white noise, pink noise, harmonic
      distortion, reverb, clipping, and a lossy codec round trip. Report level, sample rate and channel count with every
      figure.
- [ ] **Level sensitivity.** Accuracy from full scale down to -40 dBFS. A watermark that only survives loud material is
      not a watermark.
- [ ] **Stereo, and other sample rates.** The reference is mono 22050 Hz throughout. Both are untested by the reference.
- [ ] **A false-positive rate**, over real music with no mark in it. The figure that says how often an unmarked track
      appears marked, and the one that decides whether the system is usable at all.
- [ ] **A BER table for the steganographic layer**: payload bit error rate after each attack, with the audibility
      measurement beside it rather than in place of it.

## The web front end

The site goes online with the same functionality as `reference/WebBeep/www`. `docs/web.md` has what the previous version
was, what the port keeps, and how to check it. The page is a host for the codec, so it needs the codec before it needs
itself.

- [x] **`www/index.html`, `style.css` and `app.js`.** Vanilla JS, no framework, no build step beyond the Wasm module.
      Both operations run in the page. Three read outcomes as three elements, so "no mark" cannot be read as "an empty
      identifier".
- [x] **MP3 decode in the page**, by walking the frames and handing each to the browser's own `AudioDecoder` through
      WebCodecs. Needed because the files people hold from the old site are MP3s.
- [x] **Markup tests**, in `tests/web.test.js`: every id `app.js` reaches for exists, nothing loads from a third party,
      every control has a label, one live region, the touch-target and font-size rules hold.
- [x] **A Dockerfile and an nginx configuration.** Multi-stage: the Wasm core is built in one stage and the running
      image contains only nginx and the files it serves. No Node, no Rust, no npm packages at runtime.
- [x] **A deployment check** written down in `docs/web.md`, run against the container.
- [ ] **Deploy it.** Needs a host and a domain. The old site was `webbeep.it`; whether that name is kept or a new one is
      taken is still open in the decisions list, and it changes every canonical link.
- [ ] **A browser check in a real browser**, which is a person: layout at 360px, focus order, the pointer, and a screen
      reader pass. All in `HUMANS.md`, none of it checkable from a DOM without a renderer.
- [ ] **Progress and cancel that actually work.** The page has the region and the buttons; a cancel that cannot interrupt
      a Wasm call is not a cancel. Decide whether to decode in a worker so it can be interrupted, or drop the buttons.
- [ ] **Stereo.** The page and the core both work in mono, and a stereo file is refused rather than half-read.
- [ ] **The remaining pages**: `spec.html` and `applications.html` are linked from `index.html` and do not exist yet.

## Reading

Not work, but it is work before the work, and skipping it wastes a week each.

- [ ] **Read the ten papers in `reference/perplexity-pointers.md`**, at least the two that most shape the design: the
      2024 phase-coding paper for its framing (sync word, length field, CRC-16, Hamming(7,4)), and StegoHound for what an
      adversary sees. `docs/steganography.md` is reasoning on top of the survey, not a substitute for it.
- [ ] **Read `~/github/downspout/docs/porting.md`** before writing the plugin.
- [ ] **Read `reference/WebBeep/notes/`**, especially `decode-algorithms.txt`, before choosing an approach.

## Loose ends

1. **`reference/WebBeep` carries its own history**, including failed approaches in `notes/decode-algorithms.txt` (zero
   crossing, Pisarenko, per-note bandpass filters) and genetic algorithm runs. Read it before choosing an algorithm.
2. **The reference's spec is incomplete.** `www/spec.html` section 4 is a TODO, so the code is the only full account of
   decoding. Any second reading of the code is worth recording in `docs/port.md`.
3. **`reference/WebBeep/notes/TODO.txt` lists the author's own unfinished list**, including "get nearest is applied to
   goertzel, refactor" and "swap out List<Double> for Tone". Those are known-done-in-passing or known-rough; do not
   re-derive them.
