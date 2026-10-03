# How the watermark works, and what to listen for

A plain-language account of what the mark is, where it sits in a file, how it is read back, and how to check by ear
that it is not audible. The measurements behind every claim here are in [steganography.md](steganography.md), and
this document links to the sections that hold them.

## Where it is

There are no particular positions. The mark runs through the **whole file, continuously**, from the first sample the
embedder sees to the last.

- **Repeated copies.** The message is written end to end, over and over. One copy of an identifier of 22 bytes takes
  about 26 s of audio, 12 s for a few characters and about a minute for 63 (the page and the tools say how long yours
  needs). A three-minute track carries five to seven copies, which is what lets the reader combine them and survive
  damage. The arithmetic and the measured effect of copies are in
  [steganography.md](steganography.md#the-code-and-using-every-copy).
- **Spread across the spectrum.** Each bit of the message is a burst of keyed noise 2048 samples long, between 250 Hz
  and 8 kHz, so it sounds, if at all, like a very faint hiss and not like a tone. The key decides the noise; without
  it there is nothing to find. The design and the choice of carrier are in [steganography.md](steganography.md).
- **Under what the music hides, band by band.** The mark is shaped every 23 ms, in each critical band of hearing, to
  sit 6 dB under the threshold that a masking model says the music hides. So it is loud where the music is loud and
  nearly absent where it is not, and digital silence stays silent. The model, its assumptions and the tables are in
  [steganography.md](steganography.md#how-audible-by-a-model-and-the-shaped-mark-that-replaced-the-fixed-level).
  *A model is not a listener*, and that is the point of the second half of this page.
- **Both channels carry the same message,** so a fold to mono, or either channel alone, still reads
  ([steganography.md](steganography.md#stereo)).
- **Anchored to the timeline.** Which part of the carrier lands on a sample depends on that sample's position, so a
  bounce and a second bounce put the same mark at the same places, whatever block size the host uses. In the plugin
  the position is the host's timeline ([vst.md](vst.md#what-the-core-has-to-learn-first)).
- **The ends.** The plugin's output is delayed by 3072 samples (70 ms at 44.1 kHz), so the first 70 ms is silence, and
  the mark fades over the last 23 ms of a file because the end of the audio is followed by silence. The delay is
  reported to the host, which compensates for it.

## How it is read back

The reader is given a file and has to find everything blind: where a bit begins, where a copy begins, and how long the
message is.

1. It whitens the audio with a filter fitted to the file, so a loud bass line is not the loudest thing it sees.
2. It finds where bits begin by folding the file onto one carrier period, which also finds a cropped or shifted file.
3. It estimates the file's speed from where that boundary drifts, so a clock error as small as 30 parts per million, or
   a tempo change of several percent, is corrected for.
4. It correlates each block with the keyed carrier and finds the start of each copy from a sync word, pooling the
   evidence from every copy.
5. It combines every copy, partial ones included, and decodes with a convolutional code.
6. Only a frame whose magic number, version, length and CRC-16 all agree is called a mark. Anything else is a damaged
   mark or nothing, and the tools and the page say which. An unmarked file is never reported as marked: 0 of 720
   reads in the false-positive test ([steganography.md](steganography.md#the-whole-album-with-the-shaped-mark)).

What the reader survives, measured on 18 full-length tracks, is in the same document; what it does not survive, and
the fact that **the key does not protect a mark from being removed**, is in
[steganography.md](steganography.md#removal-without-the-key).

## What to listen for

The model is a proxy, and these are the places it is most likely to be wrong, in order:

- **Quiet passages and fade-outs.** The mark sits near the threshold of hearing there, and the model assumes a fairly
  loud listening level. Listen for a faint "air" that was not there.
- **Sparse or sustained tones**, such as a lone note, a pad or a piano tail. A tone hides noise less well than a dense
  mix does.
- **Just before a sharp onset**, a drum hit or a plucked note: a tiny noisy flick, called pre-echo.
- **The upper mid-range in quiet sections**, roughly 2 to 8 kHz.
- **Headphones, and louder than usual.** The mark is identical in both channels, so it sits in the centre of the image.
- **The start of playback**, where the mark begins with the audio.

## How to listen

- **A/B at matched level**, switching without stopping playback. For the original, bounce the same project with the
  plugin bypassed, which has the same delay.
- **Aim at the worst passage.** `node bin/audibility.js --in original.wav --marked bounce.wav` prints where the model
  thinks the mark is closest to being heard, and that is the best place to listen. It is described in
  [steganography.md](steganography.md#how-audible-by-a-model-and-the-shaped-mark-that-replaced-the-fixed-level).
- **Learn what it sounds like.** Make a deliberately loud one and back off:
  `node bin/mark.js --in original.wav --payload "x" --out marked.wav --strength 0`, then `-3`, then `-6` (the default).
  The loudest margin you cannot tell from the original is what decides the default; [HUMANS.md](../HUMANS.md) has this
  as the open listening item. Also try `--level relative --strength -20` once, which is what the project used before
  the shaped mark, for comparison.

## Where to go next

| For | Read |
|---|---|
| The carrier, the attacks, every measured table, the false-positive result, removal | [steganography.md](steganography.md) |
| The plugin: its design, its engine, what has and has not been checked | [vst.md](vst.md) |
| The C interface the plugin, the page and the tools all call | [ffi.md](ffi.md) |
| The page, its deployment and its checks | [web.md](web.md) |
| The original audible tone scheme and how it was ported | [port.md](port.md) |
| What is built, what is open, and what needs a person | [TODO.md](../TODO.md), [HUMANS.md](../HUMANS.md) |
| Mistakes made and what prevents them | [MISTAKES.md](../MISTAKES.md) |
| The original brief | [initial-thoughts.md](initial-thoughts.md) |

How to run it: `./install.sh` builds and installs the plugin, `node bin/mark.js` marks and reads a file,
`node bin/attack.js` and `node bin/corpus.js` measure what survives, and `node bin/audibility.js` and
`node bin/false-positive.js` measure the other two things that matter. The [README](../README.md) lists them.
