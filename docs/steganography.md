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