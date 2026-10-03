# The embedding plugin

A plan for a VST3 plugin that puts the watermark into a track inside a DAW, as the last stage of a mastering
chain. Written 2026-10-03, before any of it exists, and meant to be argued with.

## Two plugins, and which one this is

`AGENTS.md` describes the third delivery as a plugin that takes text and emits a repeated MIDI pattern derived from
it, usable as a bassline or melody. That is a different plugin with a different carrier, and it is still planned,
later. **This document is about the other one**: an audio insert that takes a stereo (or mono) signal in, puts the
spread-spectrum watermark that `docs/steganography.md` describes into it, and sends it on. Call it **Mark**.

Both follow the same rules from `AGENTS.md`: it embeds and never extracts (no detector in the plugin, whatever the
symmetry), anything it adds to the sound beyond the mark is a defect, nothing blocks the audio callback, and a change
of parameter must not change anything already rendered. The MIDI plugin is `TODO.md`'s "MIDI carrier" items and stays
there.

## What it does, from the user's side

A mastering engineer puts **Mark** at the end of the chain, types an identifier (usually a URL or IRI) and a key
phrase, leaves the margin at its default, and bounces. The bounce carries the mark. Nothing audible changes by
design, and what "by design" means is a model's view that a listener has not yet confirmed (`HUMANS.md`).

Controls:

- **Identifier**, up to 63 characters (the same limit and the same UTF-8 as the page and the tools).
- **Key**, a phrase, optional. Empty means the public default key, which anyone can read, and the plugin says so.
- **Margin**, how far under the modelled masking threshold the mark sits, -12 to 0 dB, default -6.
- **Bypass.** A bypassed plugin still delays the signal by its latency, so toggling it does not move the audio.
- **Readouts, no meters of the audio**: the identifier's byte length, how long one copy of the mark takes at the
  current sample rate ("needs 26 s of audio to be complete once"), and how many seconds of the mark have been
  written since playback began. A warning when the output peak goes past 0 dBFS, which the mark alone can cause on a
  master that already touches it.

Not in the plugin, on purpose: a reader. A user in a mastering chain never decodes from it, and an extractor that
shares a binary with an embedder is two things that can drift. Extraction is the native applications' job.

## Architecture

The shape is downspout's, which is already settled on this machine (`~/github/downspout`, DPF vendored in
`third_party/DPF`, plugins as `include/`, `src/`, `src/dpf/`, `tests/`, CMake with `dpf_add_plugin`):

```
  DAW  ->  DPF wrapper + NanoVG UI  ->  C++ engine (no DPF, no host types)  ->  Rust core, extern "C"
                src/dpf/                      include/ src/ tests/              libfluidmark_core.a
```

- **The Rust core stays the only implementation.** The plugin links the static library the build already produces
  (`build/libfluidmark_core.a`, `wasm/tests/link_check.cpp` already proves a C++ program can call it). Nothing in the
  plugin re-implements the carrier, the model or the shaping. That is the "one codec" rule, and it is the reason the
  mark that comes out of a DAW reads in the browser.
- **The C++ engine** is thin and portable: it owns a core handle, turns host buffers into calls, reports latency and
  holds the parameters. No DPF types, so CTest can run it with no DAW.
- **The DPF wrapper** maps parameters and state to the engine and the engine's outputs to the host. The UI is NanoVG,
  custom, like downspout's.
- **Layout in this repository**: `vst/` with `CMakeLists.txt` and `vst/mark/{include,src,src/dpf,tests}`, the Rust
  build driven from CMake (a custom target that runs `cargo build --release` for the host triple), and DPF found
  from `DPF_ROOT`, defaulting to downspout's copy so it is not vendored twice.
- **Metadata** follows downspout: creator `danja`, group `Downspout`, brand and URI under the same family, so they sit
  together in a plugin list.

## What the core has to learn first

This is the real work, and the plugin is small beside it. Today's embedder is offline: it measures thresholds over
the whole file in one pass and then adds the mark in another, which cannot run in an audio callback. It needs a
**streaming embedder** in the Rust core, and that should become the only embedder, with the offline call a wrapper over
it, so that the page, the tools and the plugin run the same code and produce the same bits.

The shape of it:

- **A state machine over hops.** Frames of 2048 and a hop of 1024, as now. It takes input a block at a time, keeps
  what it needs in preallocated ring buffers, and releases output a fixed delay later.
- **Latency, stated and exact.** A sample's mark needs the thresholds of the two frames that cover it, and each
  frame's threshold is the lowest of its own and its neighbours' (so a mark under the threshold in the quiet before a
  loud note is under it at the note). That needs audio about one and a half frames ahead, so the delay is of the
  order of 3000 to 4000 samples, 70 to 90 ms. The exact figure comes out of the implementation and is held by a test,
  and the plugin reports it to the host, which compensates. For a mastering insert that is free; for tracking it
  would not be, and the plugin is not for tracking.
- **No allocation, no locks, no panics in `process`.** Everything is allocated at `prepare`, which runs off the audio
  thread: FFT work arrays, the threshold ring, the carrier generator and its resampler. `process` returns a code and
  never unwinds (the build is `panic = "abort"`, and the plugin links statically so an abort is the host's problem
  only if there is a bug, which the tests are there to find).
- **Position, not block index.** The carrier at output sample `i` depends on `i` only. In the plugin `i` is the host's
  timeline position when it is playing, so a bounce, a second bounce and a different block size all render the same
  mark, and a loop or a seek continues from where the timeline says. Offline `i` starts at 0, as now. A jump in
  position that is not a multiple of the copy length means the copies on either side are out of step with each other,
  and the reader, which finds copy boundaries blind and combines what lines up, loses nothing but the cross-jump
  combination. A bounce has no jumps.
- **Any sample rate.** The mark is defined at 44.1 kHz and resampled on the fly to the host's, which the offline
  embedder already does per sample; the streaming one has to do it without knowing the length. At 88.2 and 96 kHz the
  analysis frame is scaled to keep the same time and frequency resolution (the bands are in Hz), and that needs the
  model checked at those rates, which it has not been.
- **Parameter changes.** The margin is smoothed over a hop, so it never steps. The identifier and key take effect at
  the next copy boundary, not mid-copy, so a copy is never half one message and half another and a replay of the same
  automation renders the same audio. Nothing already released changes, because everything released is already in the
  host's hands.
- **Cost.** A hop is about four 2048-point FFTs and some band arithmetic per channel, well under one percent of a
  core. A benchmark in the tests holds it, since "it should be fast" is not a measurement.

## Testing without a DAW

Everything below runs under CTest with no host, as downspout's cores do, plus the Rust tests that already exist.

- **Bit equality with the offline embedder.** The streaming embedder's output, delayed by its latency, equals what
  `embed` returns today for the same input, on fixtures with fixed seeds. The offline embedder's current output is
  the reference, kept as golden vectors, and it is the reference the same way the Java was for the tone port: not the
  new code compared with itself.
- **Block-size independence.** The same audio in blocks of 1, 7, 64, 480, 1024, 4096 and random sizes gives the same
  bits out.
- **No allocation in `process`**, checked by interposing `malloc` and `free` in the test and counting. A claim about
  real-time safety with no measurement is the claim `AGENTS.md` says not to make.
- **Latency**, by an impulse and by the equality test above.
- **Round trip through the reader.** Render a track through the engine in host-sized blocks, hand the result to
  `core_ss_detect` from the same C++ test, and require a verified payload that equals the one that went in. That is the
  end-to-end check, and it uses the core's reader, so the claim "a DAW's mark reads in the browser" is one test.
- **Parameter behaviour**: an identifier change lands at a copy boundary and not before, a margin change has no
  step, and a replay of the same automation gives identical output.
- **Rates and channels**: 44.1, 48, 88.2 and 96 kHz, mono and stereo.
- **The audibility model's own verdict**, through `core_nmr`: the rendered mark's modelled ratio sits where the margin
  says. That repeats what the Rust test holds and does so through the C++ path, so a wiring mistake shows.
- **Host checks, environment-dependent and reported separately**: `pluginval` (or the VST3 SDK's validator) on the
  bundle, and loading it in Carla and REAPER. These need tools and a person (`HUMANS.md`).

## Where it stands

**Milestones 1 and the core of 2 are done** (2026-10-03). `wasm/src/mark_stream.rs` is the streaming embedder and
the offline masked embedder is now that stream fed a whole channel, so every host runs one code path. It matches the
whole-file embedder it replaced to the bit, at 44.1 and 48 kHz, everywhere except the last three hops, where the
old one stopped its carrier at the end of the file and clamped the last frame's neighbours and the stream is followed
by silence instead. The mark therefore fades over the final hop, which is the right thing at the end of a track and
a difference of a few tens of milliseconds in a minute. The latency is exactly `3 * HOP = 3072` samples (70 ms at
44.1 kHz, 64 ms at 48), held by a test. Output is the same for any block size, from 1 sample to 4096 and mixed, and
for a stream that starts part-way along a timeline. Nothing is allocated while it runs, counted by a wrapped
allocator with a control that the counter counts. The C ABI (`docs/ffi.md`) and a C++ link check that drives it with
a plugin's call pattern pass.

Left in milestone 2 and then 3: a new identifier or key at a copy boundary (the two configurations alive across the
boundary, the old one freed off the audio thread), the model at 88.2 and 96 kHz, and the C++ engine with its own
CTest suite.

## Milestones

Each ends with something that runs, and each is useful before the next.

1. **Streaming embedder in the Rust core.** Hop state machine, preallocated, position-based carrier, streaming
   resampler, exact latency, golden-vector equality with today's offline output, and the offline call rebuilt on it.
   The page and the tools benefit at once: marking a long file stops needing the whole track in memory, and progress
   becomes possible. *This is the part to start now.*
2. **The C ABI for it**: create, reconfigure, process, latency and destroy, with `docs/ffi.md` updated and
   `link_check.cpp` extended so a C++ program drives a stream.
3. **The C++ engine and its CTest suite.** Everything under "Testing without a DAW" except the host checks.
4. **A DPF wrapper with no UI** (generic parameter UI, identifier and key as state strings). Builds a VST3. A person
   loads it in REAPER and Carla and listens. This is the first point at which a human is needed.
5. **The NanoVG UI**: text entry for the identifier and key, the margin, the readouts and the warnings. Text entry is
   custom, since NanoVG has none, and is the one fiddly part of the UI.
6. **Packaging and CI**: Linux first, as downspout does, then the other platforms, which are untested until someone
   has them.
7. **The listening check**, which is `HUMANS.md`'s and which decides the default margin the plugin ships with.

## Decisions that are the user's

These change what gets built, and are listed here rather than assumed.

- **The payload.** A bare identifier, or an identifier plus something that differs per render, such as a render
  serial or a date? A serial makes each bounce distinguishable, which helps tracing a leak and is the opposite of what
  the mark's own robustness against averaging copies wants (two differently-marked copies average into a damaged or
  mixed mark, which `docs/steganography.md` measured). That is a payload-format decision, still open in `TODO.md`.
- **Where in the chain.** The recommendation is last, before dither and before the final conversion, and after the
  limiter, with the plugin's peak warning on. The mark can lift a peak by a fraction of a dB, so a master that touches
  full scale needs either a little headroom or the plugin ahead of the limiter. Which the user's workflow wants is a
  question for the user.
- **The key.** It is stored in the project file as text, so anyone who can open the project can read it. For a key
  that must stay secret, the plugin cannot be the place it lives; the alternative is a key file outside the project,
  at the cost of a plugin that reads files. The default is the project file, with that stated in the UI.
- **Platforms.** Linux first (this machine, REAPER). macOS and Windows follow downspout's lead: built, and untested
  until a person tries them.

## Risks, in the order they are likely to bite

1. **Latency and the model at other sample rates.** The model has only been run at 44.1 kHz in the tests and 48 kHz in
   the embedder tests. Scaling the frame for 88.2 and 96 kHz is a change to the thing the whole audibility argument
   rests on, and wants the NMR table re-measured, not assumed.
2. **A seam in the streaming rewrite.** Moving the embedder to a hop state machine changes its numerics at the
   edges of frames and at the start and end of a stream. The golden-vector test is there to make any change a
   decision and not an accident, and the first milestone's job is to make the bits agree or to say, with a
   reason, why they do not.
3. **Text entry in NanoVG**, and keyboard focus inside a DAW's plugin window, which hosts handle differently.
4. **Hosts that call `process` with changing block sizes, or with zero frames, or in a different order after a
   sample-rate change.** Block-size independence is tested, and a reset on a rate change is part of `prepare`.
5. **Static linking a Rust library into a VST3.** The library needs `-lpthread -ldl -lm` and has to be built for
   the same triple and with position-independent code. It is a build fact to settle in the second milestone, not a
   design question.
6. **What the plugin cannot know.** It does not know the track's length, so it cannot say whether the mark will fit
   once; it says how long one copy is and leaves the rest to the user. It cannot know a mark is already there, and
   marking an already-marked track under another key leaves two marks that cost each other margin, which the
   documentation for the user has to say.
