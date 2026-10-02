# The first step: porting WebBeep, and where it stops being enough

WebBeep is watermarking by audible tone. This document says what it does, what a faithful
port looks like, and why the port is not the finish line.

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