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
