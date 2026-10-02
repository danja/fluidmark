# Delivery 1: the first pass, and where it stops being enough

WebBeep is watermarking by audible tone. This document says what it does, what a faithful
port looks like, and why the port is not the finish line.

This is delivery 1 of 3 in `docs/initial-thoughts.md`: the baseline that makes the plumbing,
the codec and the attack harness real. Delivery 2 is the VST plugin (a MIDI carrier), and
delivery 3 is the steganographic layer and the native applications, which are the goal and are
in `docs/steganography.md`.

## What WebBeep does

Read from the reference implementation rather than from its spec, because the spec's
section 4 (Decoding) is a TODO marked informative and the code is the only full account.
Since fluidmark is a port and an extension of this work, the reference is a source to copy
and rework rather than a specification to comply with.

**Encoding.** The payload is a string, punycoded with `IDN.toASCII`. A checksum character
is prepended: the sum of the bytes, modulo 128. Each ASCII character's value is then split
into two nibbles, and each nibble indexes a table of frequencies:

- A low tone, `Maps.LOW_FREQ`, 8 entries from 261.63 Hz to 440 Hz.
- A high tone, `Maps.HIGH_FREQ`, 16 entries from 523.25 Hz to 1760 Hz.

The low nibble picks the high tone, the high nibble picks the low tone. Each entry also
carries a duration (`LOW_BEATS`, `HIGH_BEATS`), which is either one beat or half a beat, so
tone duration carries information as well as frequency. Each character therefore becomes a
dual-tone chunk, and the chunks are merged into one waveform. `DefaultEncoder` pads the
result with a second of silence at each end.

**Decoding.** `DefaultDecoder` is a pipeline of pluggable processors, each with its own
tunable parameters: normalise, optional compressor, high-pass and two low-pass FIR
filters, a cropper that finds the start by threshold, a chunker that splits at fixed
intervals, per-chunk normalise, and an envelope shaper. `CharacterDecoder` takes each pair
of chunks and runs a `GoertzelPitchFinder` over both, which computes Goertzel power at each
of the 24 table frequencies and reports every one above a threshold. The count and identity
of the detected pitches reconstruct the character.

**The payloads are tones summed into the track.** `WaveMaker.makeDualtone` adds the two
sine waves together and `DefaultEncoder` returns that. There is no spreading, no spectral
shaping, and no psychoacoustic model anywhere in the tree: a grep for `inaudib`,
`spread spectrum`, `psychoacoust` and `percept` across all 122 Java files returns nothing.
The only defence against noise is `GoertzelPitchFinder`'s fixed threshold, and the only
defence against the wrong pitch being read is the note table.

**Robustness was bought by search.** `go/` is a genetic algorithm that tunes around thirty
parameters across the encoder and decoder to maximise decode accuracy over random payloads.
`notes/success.txt` records a run reaching `accuracy = 1.0`. That is the shape of a visible
system being fitted to survive interference, not a hidden one. `notes/tests.txt` lists the
intended interference: white noise, pink noise, harmonic distortion, reverb.

**Known fragile points, from reading the code.** The checksum is a plain byte sum modulo
128, so it detects a wrong length but not a transposition, and `Checksum.checksum` logs a
mismatch and returns the string anyway rather than failing. `Cropper` finds the start of the
mark by threshold, and if nothing crosses the threshold `findStart` returns -1, `subList`
throws, and the exception is caught so the decode continues on an uncropped, shifted grid.
`Chunker` hardcodes a chunk grid derived from `Constants.TONE_DURATION` and relies on the
start offset being right to within that grid, with a comment noting silence between tones is
not handled correctly. `CharacterDecoder.decodeChar` compares `double` frequencies for exact
equality against the table (`note == freqs[i]`), which works only because the finder reports
table values rather than measured ones. Each of these is written down with its reading in
[MISTAKES.md](../MISTAKES.md).

## What a faithful port looks like

Vanilla JavaScript for the parts that are glue and structure, Rust to WebAssembly for the
parts that are arithmetic over sample arrays. Node tools as the interface, Vitest for tests.

Port as-is first, including the fragile parts, and record each one rather than fixing it
quietly. A port that quietly repairs a bug is a port nobody can check against the
reference, and these are the parts most likely to be wrong later. Once the port is working,
the fragile parts become the backlog rather than the specification.

Roughly in dependency order:

| Piece | Language | Why |
|---|---|---|
| `Tone`, `Chunks` | Rust | Sample buffers, the hot path |
| Goertzel power, pitch finder | Rust | Per-sample loop over 24 frequencies per chunk |
| FIR and IIR filters, resampler, normalise, compressor, envelope shaper | Rust | Same |
| WAV read and write | Rust | Byte twiddling over a whole file |
| Tone tables (`Maps`, `Constants`) | JS | Frozen data, one source of truth |
| ASCII codec, checksum, punycode | JS | Cheap, and needs to be readable |
| Chunker, cropper, pipeline | JS | Structure and ordering, not arithmetic |
| Encode, decode, CLI tools | JS | Orchestration |

The Rust crate emits a `staticlib` and a Wasm module from one source, so the C++ hosts link
the same DSP the browser does. See `docs/ffi.md`.

## Where the port stops being enough

The port is a baseline: correct, tested, and audible. Reaching the goal needs three things
WebBeep has no part of.

**The embedding has to become inaudible.** Tones at 0.49 amplitude over music are plainly
audible. An inaudible mark lives under a perceptual masking threshold that depends on
frequency, time and the programme material around it, so embedding needs per-band gain from
a masking model and decoding needs to work at a signal-to-noise ratio far below anything
the reference handles. This is the largest single piece of work and it is not a port.

**Decoding has to find its own framing.** WebBeep knows where the payload starts because the
caller passes a file that is mostly payload, and the cropper's threshold finds the edge. A
watermark in real music has no edge, so the decoder needs synchronisation, error
correction, and a way to distinguish a mark from programme material that happens to look
like one. A false positive is worse than a miss for this use: claiming a track is licensed
when it is not is a real failure.

**Payload capacity and robustness trade off, and the trade has to be stated.** One
character per ~97 ms of audio is a low rate. Real watermarking wants a compact payload
(a URL or short ID), forward error correction, and interleaving so a burst of damage costs
symbols rather than the message.

## Success criteria for the port

Not "it decodes what it encoded", though that is the floor. The port is done when:

1. The reference implementation's own test material in `reference/WebBeep/data/` round
   trips through the port, and the outputs are compared against the reference rather than
   against themselves.
2. Decode accuracy is measured over the interference list in `notes/tests.txt` (white
   noise, pink noise, harmonic distortion, reverb) and over a lossy codec round trip, with
   the figures in a document rather than in a chat message.
3. Every fragile point listed above has either been reproduced or been recorded as
   deliberately not reproduced, with a test that would notice if it changed.
4. The result runs from Node. Nothing in the port requires a browser, and nothing in it
   requires a display.
## Where the port has got to, and how it was checked

Checked on 2026-10-02, with `npm test`.

**It reads the reference's own output.** The file that settles whether this is a port is
`reference/WebBeep/data/beeps.wav`: the reference's `CodecTest` encodes the string `"abc"` into
it, so recovering `"abc"` is two implementations agreeing rather than a round trip through our
own encoder. It does.

| Reference material | Result |
|---|---|
| `data/beeps.wav` | `abc`, correct |
| `data/testin.wav`, `noisy.wav`, `reverby.wav`, `3db-clipping.wav` | no mark found, correct |
| `www/audio/qwe.mp3`, `dfgdfg.mp3`, `sdfsdfs.mp3`, `Qwerf.mp3` | recovered, matching the filename |
| `www/audio/ISP_loveSP_you!.mp3` | `I love you!`, correct |
| `www/audio/Example.mp3` | twenty printable but wrong bytes; **refused** on checksum |

The `Example.mp3` case is the interesting one. A twenty-character payload decodes to plausible
printable characters that are not the payload, which means the grid has drifted rather than the
tones being absent. The checksum catches it and the decoder reports "damaged" instead of a wrong
answer, which is the behaviour that matters more than recovering it. It is recorded as a test so
the failure stays visible.

**94 of 95 printable ASCII characters round trip**, each tested alone. The one that does not is
`@` (0x40), and the reason is marginal: the cropper trims to the samples above the threshold, and
for that byte the trimmed length falls two samples short of the decoder's second crop, so the
final character has no crop to be read from. One sample of margin fixes it, and
`core_encoded_size` now allows a sample per chunk for exactly this reason.

**The parameters are not the defaults.** The port uses the values in `data/config.xml`, which the
reference's genetic algorithm produced, rather than those in `Constants.java`. With the
`Constants.java` defaults the round trip does not work at all, and `MISTAKES.md` has the
mechanism.

### What is still missing from the first pass

- The **filters**: high-pass and two low-pass FIRs, and the compressor. All four are off in the
  configuration that works, so they are not on the critical path, and they are the largest
  remaining piece of the reference.
- **Punycode and the checksum** are on the JavaScript side rather than in the core, on the grounds
  that they are a text concern and the platform provides punycode in both hosts.
- **Resampling.** The reference is 22050 Hz throughout and this port is too. Real music is 44.1 or
  48 kHz, and this is where a tone-based mark breaks first.

## A decision made while porting: where the codec lives

The plan had the pipeline split across the boundary, with the DSP in Rust and the chunker, cropper
and pipeline in JavaScript. With the boundary real, that means a buffer allocation and a copy per
stage, for a pipeline of about six.

It is now: **everything that touches samples is in Rust**, including the tone tables, waveform
generation, envelope, normalise, crop, chunk and the pitch finder. **Text stays in JavaScript**,
where punycode, checksums and string handling are built in. The boundary is crossed twice per
operation, once for the payload bytes in and once for the tones or the payload out.
