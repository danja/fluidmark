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
Hamming(7,4) coded and keyed-interleaved) repeats end to end for as long as the track lasts. The
reader whitens the audio with an LPC filter fitted to the file, finds the bit boundary by folding the
file onto one carrier period and summing circular cross-correlations (so a crop or time shift costs
nothing), correlates each block with the carrier for a soft value, finds the copy boundary from the
sync word, then soft-combines every whole copy before the Hamming decode. A file at another sample
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
audio is denser, and the same scheme dropped to 17 and 18 of 20.

| Host | Length | Level |
|---|---|---|
| `loops`: eight drum and instrument loops from Sonic Pi's sample set, joined | 46.6 s | mean -16 dBFS, peak 0 dBFS |
| `round60`: a minute of a long personal recording, local only and not in the repository | 60 s | mean -34 dBFS, peak -17 dBFS |

44.1 kHz mono, 22-byte payload (32-byte frame), mark at -20 dB relative to the host in band. Two to
three copies of the stream fit. Every row that reads is a bit error rate of 0.0%, so only the
outcome is shown; `n/a` means no sync was found, which is not a bit error rate.

| Attack | `loops` | `round60` |
|---|---|---|
| none (control) | read | read |
| unmarked track (control) | none, correct | none, correct |
| gain -6 / -0.5 / +3 dB | read | read |
| dither 48 / 36 dB SNR | read | read |
| white noise 30 dB SNR | read | read |
| white noise 20 dB SNR | **lost** | read |
| pink noise 30 dB SNR | **lost** | read |
| pink noise 20 dB SNR | **lost** | **lost** |
| low-pass 5 kHz / 1 kHz | read | read |
| high-pass 200 Hz | read | read |
| high-pass 2 kHz | read | **lost** |
| resample to 48 kHz | read | read |
| resample to 22.05 kHz | read | read |
| time shift 1000 samples | read | read |
| crop first 5% | read | read |
| mp3 128k | read | read |
| mp3 64k | read | read |

The bar set above is met: `resample to 48 kHz` and `mp3 64k` both beat 50%, by being read exactly,
on both hosts. The noise rows are SNR against the host's peak, so "20 dB" is noise ten times quieter
than the loudest sample and far louder than a mark at -20 dB of the band. Losing there is not
surprising. The high-pass 2 kHz loss on the quiet recording is the scheme running out of band:
2 kHz to 8 kHz is what is left.

### The margin is thin, and that is the finding

Strength sweep, same hosts, same list (the control row included):

| Mark level | `loops` | `round60` |
|---|---|---|
| -20 dB | 17 of 20 | 18 of 20 |
| -23 dB | 16 of 20 | 14 of 20, `mp3 64k` lost |
| -26 dB | 13 of 20 | 0 of 20, control lost |
| -32 dB | 1 of 20 | 0 of 20 |
| -38 dB | 0 of 20 | 0 of 20 |

It falls off a cliff, not a slope. That is what a correlation receiver does: there is a threshold
where the sync peak stops standing above the noise, and below it nothing reads, including the untouched
file. Between -20 and -23 dB is the last 3 dB of margin on a track a minute long.

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
- Two hosts, one payload size, mono. The mark's level follows the host's in-band RMS per 1024-sample
  block, which is a crude stand-in for a masking threshold and not a model of one.
- It is slow enough to notice: about 0.6 s to embed and 1.7 s to read a minute of audio in Wasm.

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
