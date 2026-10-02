# TODO

What the project needs. Remove an item when its implementation and verification are complete, and keep whatever it left
undone as an item of its own. Review periodically. What is built is in `git log`, and mistakes are in [MISTAKES.md](MISTAKES.md).

Later thoughts that have not been accommodated yet go in [INBOX.md](INBOX.md). Actions only a person can take are in
[HUMANS.md](HUMANS.md). The shape of the first step is in [docs/port.md](docs/port.md).

Nothing has been started. The items below are ordered so that each unlocks the next.

## Decisions first

- [ ] **Choose the embedding layer's direction, because it decides the port's shape.** An inaudible mark needs per-band
      masking from a psychoacoustic model; a robust audible mark does not. `docs/port.md` argues the port is worth doing
      either way, but if the answer is a spread-spectrum or phase-manipulation scheme rather than a tone overlay, the
      tone tables in the reference are not the ones to port. Decide before porting them.
- [ ] **Decide the payload format.** One character per ~97 ms is the reference's rate and it is low. A compact payload (a
      short ID or a URL), a length header, and a checksum strong enough to catch a transposition are all still undecided.
- [ ] **Decide the false-positive policy.** What does the detector do when it finds tone-like structure that is not a
      mark? This is the decision that most affects whether the system is usable, and it needs stating before the detector
      is written rather than after it misfires.
- [ ] **Decide what "inaudible" means as a number.** A target, a measurement method, and a threshold. Without one,
      inaudible is a claim with nothing behind it. `TODO.md` cannot check it either; it needs the test named.
- [ ] **Decide the supported formats and sample rates.** The reference is mono 16-bit 22050 Hz throughout. Real music is
      not, and resampling is where a tone-based mark breaks.
- [ ] **Decide the site's name and URL.** The previous version was `webbeep.it`. Keeping it or choosing a new one affects
      every canonical link and the `doap.xml`, and it is cheaper to decide before there are pages than after.
- [ ] **Decide the Wasm boundary for a long decode**: whole file at once, or blocks in a worker. Blocks are what make a
      progress indicator and a cancel possible, and they change the buffer ownership rules from one file to one block.

## Foundations

- [ ] **Set up the repository.** `package.json`, `src/`, `wasm/`, `bin/`, `tests/` mirroring `src/`, Vitest wired up, and
      `wasm/` as a Rust crate building to `wasm32-unknown-unknown`. One test that fails when it should, because a suite
      that has never gone red is not known to work.
- [ ] **Decide how Rust and JavaScript share data.** One `WebAssembly.Memory` owned by Rust with views handed out, or
      per-call allocation. This determines whether the audio path can allocate, so decide it before there is an audio path.
- [ ] **WASM boundary tests**, before any DSP is ported: allocation, views, what happens when memory grows under a live
      view. Get the boundary wrong and every later DSP bug is ambiguous.
- [ ] **Typed `.d.ts` declarations for the Wasm module's public surface**, so the JavaScript side is not reaching into an
      untyped object.

## The port itself

In dependency order. Each piece is ported as the reference does it, fragile parts included, with `docs/port.md` recording
the reading taken. See `docs/port.md` for the table of which piece goes in which language.

- [ ] **`Tone` and `Chunks`** in Rust: the sample buffer types everything else operates on.
- [ ] **Goertzel power and the pitch finder** in Rust. The single hottest loop in the system: 24 frequencies per chunk.
- [ ] **Filters, resampler, normalise, compressor, envelope shaper** in Rust. FIR and IIR designs carry real parameters
      that have to match the reference's exactly or nothing decodes.
- [ ] **WAV read and write** in Rust, plus a fixture loader for the reference's `data/*.wav`.
- [ ] **Tone tables** (`Maps`, `Constants`) in JavaScript as frozen data, imported by both sides. One source, per the
      repository conventions.
- [ ] **ASCII codec, checksum, punycode** in JavaScript.
- [ ] **Chunker, cropper and the processor pipeline** in JavaScript.
- [ ] **Encode and decode entry points**, then `bin/` tools for encode, decode, and a robustness sweep.
- [ ] **Comparison against the reference.** Run the reference, run the port, compare outputs on the reference's own
      material in `data/`. Self-comparison passes for a port that is wrong the same way twice, so this is the check that
      decides whether the port is a port.

## Verification

- [ ] **Round trip** on the reference's test material, compared against the reference's output.
- [ ] **Interference suite**, over the list in `reference/WebBeep/notes/tests.txt`: white noise, pink noise, harmonic
      distortion, reverb, clipping, and a lossy codec round trip. Report level, sample rate and channel count with every
      figure.
- [ ] **Level sensitivity.** Accuracy from full scale down to -40 dBFS. A watermark that only survives loud material is
      not a watermark.
- [ ] **Stereo, and other sample rates.** The reference is mono 22050 Hz throughout. Both are untested by the reference.
- [ ] **A false-positive test**: real music with no mark in it, decoded. The figure that says how often an unmarked track
      appears marked.
- [ ] **The audibility check**, once there is an inaudible embedding to check.

## The web front end

The site goes online with the same functionality as `reference/WebBeep/www`. `docs/web.md` has what the previous version
was and what the port keeps. Ordering: the codec has to exist and be tested first, since the page is a host for it.

- [ ] **Encode outputs WAV.** The previous site encoded to WAV and then handed back an MP3 made with `lame --abr 64`, so
      a marked track arrived lossy by default. The page hands back the WAV. MP3 is not dropped from the project: it is the
      decode direction that needs it, below.
- [ ] **A lossy decoder in the page**, so an MP3 can be decoded. This is not covered by the WAV codec in the port plan and
      is a real piece of work: WebCodecs `AudioDecoder` where it exists, a WASM decoder elsewhere. Users hold MP3s because
      that is what the previous site handed them, so an MP3-only upload failing is a regression, not a missing feature.
- [ ] **`www/index.html`: Make Beeps and Decode Beeps.** Vanilla JS, no framework, no build step beyond the Wasm module.
      Both operations run in the page.
- [ ] **Progress and cancel on a long operation.** A four-minute track is not instant, and a page that appears hung is a
      page people reload.
- [ ] **Three decode outcomes, reported distinctly**: a payload, no mark found, and found-but-damaged. Returning an empty
      string for both failures teaches a user the tool is broken.
- [ ] **Accessibility to WCAG 2.2 AA**, as new work rather than a retrofit. The previous markup is from about 2011: no
      `viewport` tag, and image-only buttons as the visible affordance for each form.
- [ ] **Narrow layout, measured** at 360px in a real browser: `scrollWidth` against `innerWidth`, every target 44px, text
      input 16px.
- [ ] **Port the remaining pages**: `spec.html` and `implementation.html` revised to describe the port, `applications.html`
      and `template.html` as they are.
- [ ] **The Node tools and the page driven by the same code**, with a check that notices a divergence. A codec that works
      in one host and not the other is the defect this arrangement exists to prevent.
- [ ] **Deployment check**: every page and both operations reachable by a real request, the Wasm module served with a cache
      policy decided in advance, and nothing loaded from a third party.

## Beyond the port

Not started, and each is larger than the port.

- [ ] **An inaudible embedding layer.** Per-band gain from a masking model, so the mark sits under the perceptual
      threshold rather than at 0.49 amplitude. The main event.
- [ ] **Synchronisation.** Real music has no edge for a cropper to find, so the decoder needs to acquire framing from
      nothing.
- [ ] **Error correction and interleaving.** So a burst of damage costs symbols rather than the whole message.
- [ ] **Detection at low signal to noise.** The reference's threshold of 10000 and its GA-tuned parameters are calibrated
      to a visible overlay. None of that transfers.
- [ ] **Listening.** Whether it sounds clean is a question only a person can answer, and for an inaudible mark it is the
      question that decides whether the project has succeeded (`HUMANS.md`).
- [ ] **The site, live**, with the same functionality as the previous version. See the front end section above and
      `docs/web.md`.

## Loose ends

1. **`reference/WebBeep` carries its own history**, including failed approaches in `notes/decode-algorithms.txt` (zero
   crossing, Pisarenko, per-note bandpass filters) and genetic algorithm runs. Read it before choosing an algorithm.
2. **The reference's spec is incomplete.** `www/spec.html` section 4 is a TODO, so the code is the only full account of
   decoding. Any second reading of the code is worth recording in `docs/port.md`.
3. **`reference/WebBeep/notes/TODO.txt` lists the author's own unfinished list**, including "get nearest is applied to
   goertzel, refactor" and "swap out List<Double> for Tone". Those are known-done-in-passing or known-rough; do not
   re-derive them.