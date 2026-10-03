# The steganographic layer

The actual goal. `docs/port.md` covers the first pass, which is audible and exists to make
the plumbing real. This document covers what replaces it.

Read `reference/perplexity-pointers.md` first: it is the survey, and this document is the
reasoning on top of it rather than a restatement of it.

## What the mark has to survive

The brief is that the watermark survives significant processing and degradation of the
original signal, in both the time and frequency domains. Concretely, that means a marked
track should still decode after:

- MP3, AAC and Opus transcoding, and being resampled
- gain and normalisation
- dither
- low-pass and high-pass filtering, and EQ
- a time shift, and a crop
- stereo to mono
- a DAW render and re-import cycle

That list is the spec. A scheme that survives none of it is not a watermark, and one that
survives a subset chosen after the fact is a watermark with a claim attached to it. The
attack list is `TODO.md`'s to hold, and each entry needs a figure, not a yes or a no.

## The payload

Layered, from the brief:

```
[ header: a mark is here, version, length ]
[ metadata ]
[ IRI: the source of this recording ]
[ arbitrary text ]
```

A header before anything else, so that a decoder which finds nothing recognisable can say
"no mark" rather than reporting whatever noise it managed to read as a payload. Without it,
every unmarked file produces a plausible-looking wrong answer.

The IRI is the point of the system: identify the source. It should be the one thing that is
always present and always reliable, so the arbitrary text and the metadata are the parts that
can be damaged.

## Choosing a carrier

`reference/perplexity-pointers.md` lays out six families. Ranked for this project:

**Spread spectrum, in a transform domain, is the intended answer.** Its weaknesses are
synchronisation and host interference, and its payoff is exactly what the brief asks for: a
low-rate mark that reads as noise, spread through the spectrum, surviving transcoding. The
survey's own recommendation agrees: "a low-rate transform-domain or spread-spectrum watermark
is generally a more defensible research direction than LSB" for material that will be
rendered, transcoded, mastered or streamed.

**LSB substitution is a control, not a candidate.** Worth building once as a baseline
because it is a day of work, it makes the attack harness real, and it should fail on most of
the list above. A scheme that survives the list where LSB does not is the result worth
having.

**Phase coding** is the second candidate. The survey's practical direction is the 2024
paper's framing: segments, a sync word, a length field, CRC-16 and Hamming(7,4). Those are
the parts that make it a system rather than a trick.

**Echo hiding** is interesting for music specifically, because the survey notes a dense mix
is a much friendlier host than dry solo percussion. It is also the easiest to hear and the
easiest to damage with mix processing.

**MP3 codec-domain embedding** (MP3Stego) is format-specific and well known to
steganalysis. Not for this.

**MIDI steganography** is the VST plugin's territory, not this document's. The survey's
guidance for it is to model musically constrained choices and let a secret key pick among
equivalent alternatives, rather than mapping bits onto notes.

## What the survey says is needed around the algorithm

Every robust design in the survey carries the same four things, and they are more work than
the embedding itself:

**Synchronisation.** The decoder has to find the mark in a file with no obvious start. The
survey's phase-coding paper adds a sync word for exactly this. WebBeep gets this for free by
being handed a file that is mostly payload, which is why its cropper works and why it will
not work on real music.

**Error correction and interleaving.** So that a burst of damage costs symbols rather than
the message. Interleaving matters as much as the code: without it, the transcoding damage
that arrives in one frequency band takes out every symbol in it.

**A keyed spreading sequence.** The payload is not a secret by itself; the spreading sequence
is. It also means an unmarked file has no reason to contain this signal, which is what keeps
the false-positive rate down.

**A detection story.** StegoHound in the survey is about identifying and extracting marks, and
it is on the reading list for a reason: a scheme that is trivially detectable is a scheme
whose future is decided by somebody else finding it first.

## How to know whether it worked

Three axes, and they cannot all be maximised at once, which the survey says outright.

- **Capacity.** Payload bits per second. At the rates spread spectrum allows, an IRI fits
  comfortably and arbitrary text does not. Decide what the arbitrary text is for before
  spending effort on capacity.
- **Robustness.** Bit error rate after each attack in the list above.
- **Imperceptibility.** And here the survey is the important one: **SNR alone is not a
  sufficient proxy for audibility.** Objective difference grades and listening tests are
  separate measurements, and only the second one decides whether this project has succeeded.

So a result is a table: payload BER after each attack, plus an objective perceptual metric,
plus a listening verdict from `HUMANS.md`. A number in one column and nothing in the others
is a prototype, not a result.

## Sequence

1. Build the attack harness first, against the LSB baseline. A harness written after the
   scheme exists will be written to prove the scheme works.
2. Implement spread spectrum in a transform domain, keyed, with a sync word and FEC.
3. Measure it against the harness. Expect to be worse than hoped at first; that is what the
   harness is for.
4. Then the psychoacoustic layer, so the mark sits under a masking threshold rather than at
   a fixed level.
5. Then MIDI, in the VST plugin, which is a different carrier and can be carried forward in
   parallel once the harness exists.

Step 1 before step 2 is the whole argument. The WebBeep port is a working stand-in for step 1
if its parameter search is reused, which is in `INBOX.md`.

## The harness, and what the LSB baseline does through it

Built 2026-10-02, before the scheme it measures. `node bin/attack.js --in track.wav --payload "text"`
runs the whole list and prints a table; `--json` gives the same figures as JSON. The list lives in
`src/attacks.js` and the transforms in `wasm/src/attack.rs`.

Measured on a 4-second 44.1 kHz mono test track, one bit per sample at keyed positions, a 32-byte
frame of 256 bits.

| Attack | BER | Payload readable |
|---|---|---|
| `none (control)` | 0.0% | yes |
| `gain -6 dB` | 47.7% | no |
| `gain -0.5 dB` | 48.0% | no |
| `gain +3 dB` | 43.8% | no |
| `dither 48 dB SNR` | 50.4% | no |
| `dither 36 dB SNR` | 53.5% | no |
| `white noise 30 dB SNR` | 45.7% | no |
| `white noise 20 dB SNR` | 44.9% | no |
| `pink noise 30 dB SNR` | 48.0% | no |
| `pink noise 20 dB SNR` | 47.7% | no |
| `low-pass 5 kHz` | 53.9% | no |
| `low-pass 1 kHz` | 50.8% | no |
| `high-pass 200 Hz` | 50.8% | no |
| `high-pass 2 kHz` | 54.7% | no |
| `resample to 48 kHz` | 50.0% | no |
| `resample to 22.05 kHz` | 45.3% | no |
| `time shift 1000 samples` | 53.1% | no |
| `crop first 5%` | 50.8% | no |
| `mp3 128k` | 43.8% | no |
| `mp3 64k` | 46.5% | no |

Every figure is a bit error rate against **the frame that went in**, not against whatever decoded, so
a frame that fails its checksum still has a rate and that rate is the measurement. The lossy rows
need ffmpeg and are reported separately whether or not it is installed.

**This is the calibration, and it is the expected result.** Near-50% BER is random: the mark is
gone. Not one attack in the brief's list leaves the payload readable, including a gain change of half
a decibel, which is what the survey predicts for sample-bit schemes and what an earlier version of
this work got wrong by assuming that a small gain is "representable in 16 bits".

Two tests guard it, in `tests/attacks.test.js`, and both matter:

- The LSB baseline is destroyed by every attack in the list. If that stops being true, the harness
  is broken rather than the scheme having improved.
- The control row reads back perfectly. Without it, a harness that destroyed everything would look
  exactly as convincing.

A false-positive measurement sits alongside them: 20 noise buffers, zero reported as carrying a
mark. For this scheme that is structural rather than lucky, because the frame opens with four
specific bytes at a known offset. It is also a property LSB has by accident rather than by design,
and a scheme with a correlator will not get it for free.

### What this means for the scheme that replaces it

The list is a specification, and the bar is visible in the table above: a real scheme has to put a
number in a column where this one has 50%. Spread spectrum in a transform domain is the candidate,
and `TODO.md` has the pieces: a keyed spreading sequence, a sync word so the decoder can find the
start at all, a length field, forward error correction, and interleaving.

The two rows worth watching are `resample to 48 kHz` and `mp3 64k`. Resampling is where a
sample-domain mark dies first and where a frequency-domain one is supposed to live, and lossy
transcoding is the interference that matters most for music. If a replacement scheme does not beat
50% on those two, it is not worth building further.

## The spread-spectrum scheme, and what it does through the harness

Built 2026-10-03 as `wasm/src/spread.rs`, with `ecc.rs`, `fft.rs`, `resample.rs` and `filter.rs` under
it. `node bin/attack.js --scheme spread` runs it through the same list as the control.

**How it works.** A keyed white carrier, band-limited to 250 Hz - 8 kHz, 2048 samples long at 44.1 kHz,
is multiplied by +1 or -1 for each channel bit and added to the host at a level that follows the host's
own level in that band. The same stream (32 keyed sync bits, then the frame's header and body, each
convolutionally coded and keyed-interleaved) repeats end to end for as long as the track lasts. The
reader whitens the audio with an LPC filter fitted to the file, finds the bit boundary by folding the
file onto one carrier period and summing circular cross-correlations (so a crop or time shift costs
nothing), correlates each block with the carrier for a soft value, finds the copy boundary from the
sync word, then soft-combines every copy, partial ones included, before the Viterbi decode. A file at another sample
rate is resampled to 44.1 kHz first, and the rate has to be told to the reader: it is the one thing
the reader cannot find blind.

**What it will and will not say.** `verified` needs the magic, version, length and CRC-16 to agree;
a found header with a bad checksum is `damaged`; everything else is `none`. The false-positive
exposure is the magic plus the CRC, about 2^-48 per candidate, and 8 candidates at most are tried.
Measured: the unmarked-track control reads `none` on every host used, and the Rust and JS suites
check unmarked synthetic music, noise, silence and the wrong key.

### Measured

Hosts were real audio, because the first run was not. On the synthetic track from `src/synth.js`
(harmonic notes and a little noise) the scheme survived 21 of 22 rows including both removal rows,
which would have been a very good result if the host had been any good. It was not: tones occupy a
few bins and leave the rest of the band nearly empty, so any mark in that band is easy to read. Real
audio is denser, and the same scheme dropped to 17 and 19 of 20 (it is 17 and 20 of 20 now, after
the changes below).

| Host | Length | Level |
|---|---|---|
| `loops`: eight drum and instrument loops from Sonic Pi's sample set, joined | 46.6 s | mean -16 dBFS, peak 0 dBFS |
| `round60`: a minute of a long personal recording, local only and not in the repository | 60 s | mean -34 dBFS, peak -17 dBFS |

44.1 kHz mono, 22-byte payload (32-byte frame), mark at -20 dB relative to the host in band. Between one and two
and a half copies of the stream fit. These tables were measured with key 2, one of the keys the sync
bug described below made unreadable, after that fix and after the coding changes below. Every row that reads is a bit error rate of 0.0%, so only the
outcome is shown; `n/a` means no sync was found, which is not a bit error rate.

| Attack | `loops` | `round60` |
|---|---|---|
| none (control) | read | read |
| unmarked track (control) | none, correct | none, correct |
| gain -6 / -0.5 / +3 dB | read | read |
| dither 48 / 36 dB SNR | read | read |
| white noise 30 dB SNR | **lost** (damaged) | read |
| white noise 20 dB SNR | **lost** | read |
| pink noise 30 dB SNR | read | read |
| pink noise 20 dB SNR | **lost** | read |
| low-pass 5 kHz / 1 kHz | read | read |
| high-pass 200 Hz / 2 kHz | read | read |
| resample to 48 kHz / 22.05 kHz | read | read |
| time shift 1000 samples | read | read |
| crop first 5% | read | read |
| mp3 128k / 64k | read | read |

The bar set above is met: `resample to 48 kHz` and `mp3 64k` both beat 50%, by being read exactly,
on both hosts. The noise rows are SNR against the host's peak, so "20 dB" is noise ten times quieter
than the loudest sample and far louder than a mark at -20 dB of the band. Losing there is not
surprising.

### The margin, and a bug that made it look thinner than it was

The first strength sweep, with the default key, showed a cliff: 17 and 18 of 20 at -20 dB, then 13 and
0 at -26 dB, and nothing readable at -32 dB. It was reported as the scheme's real margin, about 3 dB.
**It was mostly a bug.** Reading a stereo file with a user's key failed outright, and the cause was
not the stereo:

- The reader finds the start of a copy by correlating a 32-bit sync word against the soft bit values,
  and kept only peaks more than 5 "robust standard deviations" above the other scores.
- That spread is measured from the scores themselves, and every window of the stream contains data bits at
  full signal strength. So the spread grows with the mark, and a perfect mark with no noise at all can only
  peak at about sqrt(32) = 5.7 of it. A threshold of 5 sat almost on that ceiling.
- Whether a given key cleared it depended on how its sync word's sidelobes fell. On the quiet recording
  **9 of 14 keys could not read their own mark.** The default key was one of the lucky ones, which is why
  every measurement before this was fine and the sweep had a cliff in the wrong place.
- The fix is a threshold of 2.5 and sixteen candidates instead of eight. The threshold only selects which
  peaks are worth trying; the frame's magic, version and CRC-16 decide whether anything was found, so
  lowering it adds work, not false positives. `every_key_reads_its_own_mark_not_only_the_lucky_ones` and
  a test that the threshold stays well under the ceiling guard it, and both go red with the old value.

Strength sweep after the fix, same hosts, same list, key 2. The list is now 32 rows, the 20 of the brief
and 12 beyond it (speed, harsher filters and MP3, collusion), so the counts are of 32:

| Mark level | `loops` | `round60` |
|---|---|---|
| -20 dB | 29 of 32 | 31 of 32 |
| -26 dB | 24 of 32 | 30 of 32 |
| -32 dB | 20 of 32 | 22 of 32 |
| -35 dB | 16 of 32 | 18 of 32 |
| -38 dB | 0 of 32 | 4 of 32 |
| -41 dB | 0 of 32 | 0 of 32 |

The cliff is still there but it is at about -36 dB, not -23, and above it the loss is gradual. At -35 dB
the untouched file and the mild attacks still read, and what goes first is noise, narrow filtering and,
because the speed estimate needs a cleaner peak than a straight read does, speed changes. Below -38 dB
nothing reads, not even the untouched file.

The point of the sweep is that the level the scheme needs is lower than first thought, which matters
because the level that is inaudible is a listening question and may well be lower than -20 dB.

### The code, and using every copy

Two changes took the floor from about -32 dB to about -36 dB, and each was compared against what it replaced
on the same hosts and the same list.

**A convolutional code in place of Hamming(7,4).** Rate 1/2, constraint length 7 (generators 171 and 133 octal),
decoded by the Viterbi algorithm from the soft values, with a six-bit tail to end in the zero state. Hamming
corrects one wrong bit in seven and has no memory; this spreads every bit over the next six, so a short burst
of weak bits is corrected from its neighbours. It costs about 14% more channel bits, so a copy is longer (26 s
for a 22-byte identifier, where it was 22). Same hosts and rows, Hamming against convolutional:

| Mark level | `loops` | `round60` |
|---|---|---|
| -26 dB | 22 against 21 | 29 against 30 |
| -32 dB | 12 against 12 | 18 against 21 |
| -35 dB | 0 against 0 | 1 against 18 |
| -38 dB | 0 against 0 | 0 against 4 |

On the quiet recording that is about 3 dB. On the dynamic loops it is nothing, because what limits `loops` is not
the code: the sync and boundary stages fail first there. The code stays, since it is better where the code is the
limit and no worse where it is not, and the cost is a longer copy.

**Combining partial copies.** The reader used to combine only whole copies of the stream, and a track that is
only a little longer than one copy has almost none: a cropped 46-second track with 26-second copies has no whole
copy at all, and the longer code had made that worse. It now adds in every copy, including the part of one cut
off by the end of the file or by a crop, each position getting what the copies that reach it have. More copies
combined is not more false positives, since the frame's checks still decide. On `loops`, the short one: 12 of 32
became 20 at -32 dB and 0 became 16 at -35 dB, with nothing lost on the longer recording.

**A bug the first sweep found.** At -32 dB on `loops` the reader aborted, which in Wasm is a trap and not an error.
The header read from one copy and the header read from the combination of copies could disagree about the frame's
length, and the second was used to slice a buffer sized by the first. The two have to agree now, a fuzz test
mixes frames of different lengths and noise of every size through that step, and it fails on the old code.

### Stereo

Real music is stereo, so the core takes planar channels (`core_ss_embed` and `core_ss_detect` have a
`channels` argument, and `spread::embed_planar` and `detect_planar` are what they call). The policy is
the core's, so every host gets it:

- **Every channel carries the same stream**, on the same carrier, from sample zero, each at its own
  channel's level. Nothing is gained from stereo except what this buys: a fold to mono adds the carriers in
  phase, one channel alone carries the whole mark, a silent channel stays silent, and antiphase channels
  cannot cancel the mark because it is not in the host's own mid.
- **A read uses the average of the channels**, which is what a fold gives and what any one channel is half
  of. Only the first `MAX_ANALYSIS` frames are read.
- Up to eight channels. A track longer than `MAX_EMBED_FRAMES` (2^25 frames, about 12.7 minutes at 44.1 kHz)
  is refused rather than truncated.

Measured on the 60 second stereo excerpt of the quiet recording, key 2, -20 dB: 21 of 22 rows read,
including `stereo to mono (fold)`, `one channel only`, and both MP3 rows with two channels kept through
ffmpeg. The row lost is pink noise at 20 dB SNR.

A six-minute stereo file marks in about 2.3 seconds and reads in about 1.5 in Wasm under Node, with a peak of
about 0.6 GB for either. The embedder streams: the host's band level is measured in one pass into a few
floats per thousand samples, the carrier is computed where it is wanted (resampled on the fly for a track
not at 44.1 kHz), and the mark is added in place. It matches the earlier whole-vector embedder bit for bit
at 44.1, 48 and 22.05 kHz, which a test keeps true. Before that the peak was about 1.2 GB. What is left is
mostly the copies the page and the tool need anyway: the file, the decoded channels, the core's copy, and
the marked result.

### Beyond the brief: speed, drift, harsher codecs, collusion

The attack list in `src/attacks.js` is the brief. `EXTRA_LIST` and a few harness rows hold what a mark
meets in practice and the brief does not name, kept apart so that "passes the list" keeps its meaning.

**Speed and clock drift were the largest hole, and are closed.** The first version of the reader assumed
the mark's timing exactly. A file slowed by **0.003%**, a clock error of thirty parts per million, lost
the mark completely: the bit boundary moves by a sample every few thousand and the reader folds the whole
file onto one carrier period. That is the error between two audio clocks, so it would have hit any file
played out and recorded in again, and any tempo change, however small.

The reader now estimates the timing from the mark. The bit boundary is placed from a short run of blocks
at each of 32 points along the file; at the mark's own timing it falls in the same place at every point,
and in a slowed file it moves by the drift times the distance. The moves are unwrapped and a line is
fitted, which gives the speed to about a part in a million. A coarse scan over plus or minus 8% in steps
of 0.08% takes over when the drift is too large for the tracking to place the boundary at all. The file
is then resampled to the mark's timing and read as before, and a read that finds a damaged mark is
tracked once more and tried again. The frame's magic, version and CRC-16 still decide whether anything
was found, so searching speeds adds tries and not false positives, and unmarked music, music at changed
speeds and the wrong key are tested to stay empty. The reader reports the speed it corrected for, and the
page says so.

Measured, key 2, 44.1 kHz, the file telling the reader 44.1 kHz throughout (`slowed` is more samples for
the same music):

| Beyond the brief | `loops` -20 dB | `round60` -20 dB | `loops` -26 dB | `round60` -26 dB |
|---|---|---|---|---|
| slowed 0.003% | read | read | read | read |
| slowed 0.01% | read | read | read | read |
| slowed 0.1% | read | read | read | read |
| slowed 1% | read | read | **lost** | read |
| sped up 4% (PAL-style) | read | read | **lost** | read |
| low-pass 4 kHz and 2 kHz | read | read | | |
| gain -30 dB | read | read | | |
| mp3 48k and 32k | read | read | | |
| collusion, another key | read | read | | |
| collusion, same key | **damaged** | **a different payload** | | |

Past about plus or minus 8% the reader finds nothing, and a resample from 44.1 to 48 kHz read as 44.1 is
8.8%. Pitch shifting without a change of tempo is not tried: it would need the same estimate in the
frequency axis.

**Collusion.** Averaging two copies that were marked under the same key with different payloads makes the
bits where they differ cancel. On one host the reader recovered a payload that checks out and is not the
one that went in (the other copy's), and on the other it found a damaged mark. It never produced a third
payload, and it is reported as neither a survival nor a failure to read, because it is the thing a
collusion attack is for: someone with several copies learns nothing about which copy is whose from this, but
the mark does not stay with the first one. Averaging two copies marked under different keys halves each, and
both still read. Subtracting a copy of the original from a marked file leaves the mark itself, and no scheme
that is read without the original prevents that.

### What this does not say

- **It does not say the mark is inaudible.** -20 dB relative to the in-band level of the host is a
  signal difference, SNR is not audibility, and nobody has listened. A mark 20 dB under a loud passage
  is likely to be audible as hiss in a quiet one. `HUMANS.md` has the listening check, and the level
  that is acceptable may well be below the level at which this reads. If it is, the scheme has to
  gain processing gain from somewhere else (longer bits, a stronger code, per-band weighting) before it
  is a result.
- It does not say the scheme survives removal. The two removal rows are low-bit scrubs and mean
  nothing for a spread-spectrum mark, so they are LSB-only in the harness now. A keyless attack on
  this scheme (notch the band, whiten and subtract, collusion between differently-marked copies) is
  not measured.
- Two hosts, one payload size, and one key per table. The mark's level follows the host's in-band RMS per 1024-sample
  block, which is a crude stand-in for a masking threshold and not a model of one.
- Reading takes about 1.7 s for the first three minutes of any file, which is the most it looks at, and a
  few seconds more for a file that does not read straight off, since it then searches for a speed. Marking
  is about 0.5 s per minute per channel.

## How you would remove the mark

The obvious question, and it is now measured rather than argued. Two answers, both keyless:

| Removal | BER | Payload readable | |
|---|---|---|---|
| `scrub low bits` | 45.3% | no | needs no key |
| `randomise low bits` | 49.6% | no | needs no key |

Setting the low bit of every sample to zero removes it. So does randomising those bits. Neither
needs the key, neither needs to know where the mark is, and neither is audible: every sample moves
by at most one 16-bit step, about 0.003% of full scale, and the correlation with the marked audio
is above 0.999.

**The key protects the payload from being read. It does not protect the mark from being removed.**
An attacker who wants a mark gone does not need to decode it, only to destroy the samples it lives
in. Confidentiality and integrity are different properties and a secret only ever bought the first
one here.

There is also a third removal, in `docs/initial-thoughts.md`'s terms: cut the marked region out. A
fourth, which is the strongest known attack against watermarking generally, is **collusion** —
collect several differently-marked copies of the same track and average or difference them, so the
common signal cancels and the marks, which differ, do not. None of these need a key either.

### What permanence would actually require

Not one of these is fixable with a better key, and none of them makes a mark permanent. What raises
the cost:

- **Redundancy.** Spread each payload bit over many samples, so destroying one contributes nothing.
  Removal then requires destroying most of the signal's energy in the marked region, which is
  audible damage rather than an inaudible edit.
- **Error correction and interleaving.** So a targeted scrub destroys symbols rather than the
  message, which is the difference between an attack that works and one that does not.
- **A carrier with structure.** Echo, phase, or a transform-domain spread all put the mark somewhere
  that cannot be randomised away without changing the sound, which is precisely why those families
  exist and why the survey ranks them above sample-bit schemes.
- **Collusion resistance.** The hard one, and the reason nobody claims permanence.

The honest statement is that a watermark is not a lock. It raises the cost of removing an
identifier above the cost of keeping the file, which for most people means forever and for a
determined adversary means an afternoon.
