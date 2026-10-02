# fluidmark

Watermarking for music. Mark a track with an identifier, and get that identifier back out
of the marked file, where the mark is inaudible and survives significant processing and
degradation in both the time and frequency domains.

Nothing is built yet. This repository holds guidance and the plan.

## What the payload is

A header declaring that a mark is present, then basic metadata, then an identifying IRI,
then arbitrary text. The IRI is the point of the system: it says where the recording came
from, so it should be the part that is always present and always reliable.

## The three deliveries

1. **A first pass, audible.** Ported from WebBeeps, which writes a payload as tones. A
   baseline that makes the plumbing and the tests real. `docs/port.md`.
2. **A VST plugin**, following the patterns of `~/github/downspout`, that takes text and
   generates a repeated MIDI pattern derived from it, for use as a bassline or melody. A
   musical carrier rather than an audible overlay.
3. **The steganographic layer and native applications.** The actual goal: an inaudible mark,
   embedded from a native app or a mastering-chain plugin and extracted by an app.
   `docs/steganography.md`.

A browser front end goes online alongside all three, with the same functionality as the
previous site. `docs/web.md`.

## What exists so far

- `reference/WebBeep`, Danny Ayers' earlier Java implementation of audible tone
  watermarking. fluidmark ports and extends it, so this is a source to work from rather
  than a read-only exhibit: its `notes/` also hold the failed approaches and parameter
  searches worth not repeating.
- `reference/perplexity-pointers.md`, the steganography survey: ten papers with a strategy
  map and a recommended research path.
- `docs/initial-thoughts.md`, the original brief.
- `docs/port.md`, the first pass and where the reference falls short of the goal.
- `docs/steganography.md`, the carrier choice, the attack list, and how results are judged.
- `docs/web.md`, the browser front end.
- `AGENTS.md`, `TODO.md`, `INBOX.md`, `HUMANS.md`, `MISTAKES.md`, the working guidance.