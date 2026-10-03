# What removal resistance would require

A note on what it would take for the watermark to survive someone who is trying to get rid of it. Written 2026-10-03.
It is a requirements note and not a design, and nothing in it is built. The reasoning for the current scheme, and every
measurement quoted here, is in [steganography.md](steganography.md); how the mark is laid out is in
[how-it-works.md](how-it-works.md).

(The request was for `doc/removal-resistance.md`; the repository's documents are in `docs/`.)

## The threat, and what is and is not claimed today

There are two different things a mark has to survive, and the project so far has been measured against only one.

- **Degradation**, which is processing that happens to a file without anyone meaning to hurt the mark: gain, MP3,
  resampling, noise, filtering, a crop, a speed change. This is what `bin/attack.js` and `bin/corpus.js` measure, and the
  results are good.
- **Removal**, which is somebody who knows a mark may be there and wants it gone, who has the file and the published
  description of the scheme, who does not have the key, and who is willing to damage the music a little to do it.

For removal the honest present position is: **the key stops a reader recovering the payload, and it does not stop
removal.** Measured, and written up in [steganography.md](steganography.md#removal-without-the-key): the carrier is one
waveform repeated every 2048 samples and multiplied by plus or minus one, and `wasm/src/estimate.rs` recovers it from
the audio alone, with no key, to a cosine of 0.99 with the true one. The removal attack built on that is naive and did
not take the mark out, which says nothing about a careful attacker. A mark whose carrier can be read off the file can,
in principle, be subtracted from it.

Perfect resistance is not on offer. Any mark a legitimate reader can find with the key, an attacker who obtains the key
can remove, and an attacker with a copy of the original can subtract it and have the mark alone. What is worth asking is
the cost to someone with neither: how much damage to the music, and how much effort, per track.

## What would have to change

### 1. Nothing to stack: carriers that do not repeat

The weakness is structural. Every bit is the same waveform, so averaging the blocks with the right signs cancels the
music and leaves the carrier. Resistance to that needs a carrier **that differs from block to block**, drawn from a keyed
stream (a keyed generator indexed by absolute block position, the way a stream cipher is) and not from one stored period.
With one fresh keyed waveform per bit there is nothing an attacker can align and average without the key, because no two
blocks contain the same thing.

Three smaller variants do not get there, and each is worth ruling out explicitly because it is the tempting one: a
carrier rotated by a keyed random shift per block (the shifts are recoverable by cross-correlating blocks, and then the
blocks stack again), a keyed sign pattern over one fixed waveform (the signs are what the current scheme already has),
and a handful of carriers chosen between (a small dictionary is learned by clustering).

### 2. Synchronisation without a period to fold on

The reader currently finds everything by folding the file onto one 2048-sample period: where a bit begins, how fast the
file is running, where a copy begins. A non-repeating carrier removes the period, so those have to be found another way,
and each is a piece of work:

- **Bit and copy alignment** by correlating against the keyed stream at candidate offsets, with the cost and the false-
  alarm rate that a search over offsets brings. An FFT cross-correlation against the keyed sequence for a window of the
  file is the natural tool, and the unknown block index after a crop is the awkward part.
- **Speed and drift**, which today come from following where the fold's boundary moves along the file. Against a keyed
  stream they would come from searching a grid of resampling ratios, as the coarse scan already does, and refining.
- **The sync word**, which in the current layout is the same 32 bits at the start of every copy. A repeated preamble is
  itself something an attacker can average across copies and remove, and without it the reader cannot find the copies.
  Either the preamble must differ per copy (keyed on the copy's position), or the reader has to find copies from the
  data without one.

### 3. Do not let the level give the mark away

The mark's level follows the music's masking threshold, and the scheme and its parameters are published, so an attacker
can predict the amplitude of the mark in every block to within a margin. Prediction of the amplitude was part of what
made the estimate-and-subtract approach attractive, and it would remain available to an attacker even with non-repeating
carriers: with an amplitude estimate they can at least tell where the mark is strongest. It is a smaller leak than the
carrier, and it is worth knowing it is there. Partly randomising the margin per frame, keyed, costs some robustness for
some concealment, and would have to be measured.

### 4. The attacks a resistant scheme is judged against

None of these is in the harness as a careful implementation. They are the list to build, in order, before saying
"resistant" about anything:

- **Careful estimation and subtraction.** The naive version fitted signs and carrier on the same blocks it then
  subtracted from, so each pass took out more of the music than of the mark. A careful attacker holds blocks out, fits
  the amplitude per passage, and iterates. Run against today's scheme this is the attack that is expected to succeed, and
  that result is the baseline a redesign has to beat.
- **Re-synthesis.** A low-bitrate lossy codec, a neural codec or a vocoder rebuilds the audio from a model of it, and a
  mark sitting under the masking threshold is exactly what such a model discards. MP3 down to 32 kbit/s has been
  measured and the mark survived it; modern learned codecs have not been tried and are the most likely to remove a
  below-threshold mark with no key at all and little audible change. This may be the hardest attack to resist, because the
  mark is hidden by the same property the codec exploits.
- **Desynchronisation.** Local, non-uniform time warping, a slow wobble in speed, small insertions and deletions. The
  speed tracker handles a steady error and a straight-line drift; random local warps break a fold and would stress any
  correlator.
- **Collusion.** Averaging, differencing and splicing several copies. Two copies marked under the same key with
  different payloads averaged read as one of them or as damaged (measured); with non-repeating, position-keyed carriers
  the same experiment needs repeating, and a plan for many copies and many colluders is the design question in
  traitor-tracing codes, which this project has not touched.
- **Noise at the mark's own level.** Adding keyed-looking noise just under the threshold. A correlation reader has
  processing gain against it; how much is a measurement and not an assumption.
- **A known original.** Subtract the original and the mark is exposed. No scheme read without the original can prevent
  it, and it should be stated as the limit and not measured as a failure.

### 5. Keys, and what the key is for

A mark that resists removal by an attacker without the key is only as strong as the key's secrecy. Today a key is a
phrase hashed to 64 bits by FNV-1a, which is a way to turn text into the keyed generator's seed and not a password
scheme: a guessable phrase is a guessable key. The plugin stores it in the project file as text. A resistant design would
want a key with real entropy and somewhere to keep it that is not a shared project, and would need to say what happens
when a key leaks (the marks made under it are readable and removable, and nothing can recall them).

## What it costs

Each requirement above is paid for somewhere, and the costs are the reason none of it has been done:

- **Reader time and complexity.** The fold is cheap (an FFT per block). A search against a keyed stream at every offset
  and speed is much more, and the file the reader is handed may be several minutes long. The page already takes several
  seconds to say "no mark"; a keyed search could take far longer without care.
- **Robustness to the ordinary degradations,** which is what the project currently does best. The fold is also what
  makes a crop, a time shift and a clock error cost nothing. Losing it risks the figures in
  [steganography.md](steganography.md#the-whole-album-with-the-shaped-mark), and the redesign has to be run through the
  whole attack list again, on the album, before it can claim to be no worse.
- **A new format.** A different carrier is a different stream layout and so a different frame or version, and every mark
  already made is read by the old reader or not at all. There are no marks in the wild yet, which is the cheapest time to
  make that change.
- **Capacity.** None of this needs to change the payload rate, but a design that adds redundancy to resist removal spends
  some of the margin that currently buys robustness.

## How to decide, and in what order

1. **Measure before redesigning.** Build the careful estimation attack and run it against today's scheme on the album.
   If it removes the mark at a cost the music does not show, that is the result that justifies the redesign, and the
   figure to beat. If it does not, the carrier's repetition is less exposed than it looks and the case is weaker.
2. **Build the re-synthesis attacks** that can be built here (a low-rate codec through ffmpeg, a vocoder if one is
   available) and measure them, because they threaten any below-threshold mark whatever its carrier, and a redesign of the
   carrier would not help against them.
3. **Prototype non-repeating carriers** in the offline path with an FFT correlator for alignment, and measure what the
   reader loses against the full attack list on the album. A prototype that cannot find a cropped file is not a design.
4. **Only then** choose, and write the frame version, the migration and the reader change.

The decision that is the project's and not mine is how much the ordinary robustness is worth against the removal
resistance, since they pull against each other. A provenance mark that survives every honest transformation and falls to
a determined attacker is a legitimate product; one that resists a determined attacker and breaks on a re-encode is not,
and which of the two to build first is a question about who the mark is for.

## Where this sits

- The attack harness and the current figures: [steganography.md](steganography.md).
- The survey and the papers that frame this, including the one on exactly what an adversary sees:
  `../reference/perplexity-pointers.md`.
- The open item: [TODO.md](../TODO.md), under "Non-repeating carriers".
