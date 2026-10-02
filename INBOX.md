This file holds later thoughts that have not been accommodated yet. Read it at the start of a session, and periodically
during a long one.

Each item is worked into `TODO.md` or the relevant document, and struck from here once it has a home. An item left here is
an intention nothing acts on.

## Items

- ~~**The one-core question**: Rust core against C++ core, and whether both can share one.~~ Decided, and the follow-up
  question it raised is decided too. The core is Rust behind a plain `extern "C"` ABI, emitting a `staticlib` and a Wasm
  module from one source: the browser and Node use the `.wasm`, the C++ hosts link the `.a`. No embedded Wasm runtime and no
  component model. Verified on this machine before being recorded. Both are in `TODO.md` under "Decisions taken" and
  `docs/ffi.md`.
- [ ] **"No psychoacoustic effect" in the brief, read against `docs/steganography.md`.** The brief asks for a plugin that
      does not alter what the music sounds like, while the survey's answer for an inaudible mark is per-band masking derived
      from a psychoacoustic model. Those are the same goal stated two ways, but the second is a mechanism and the first
      reads as a property. Worth settling whether the requirement is "inaudible to a listener" (measurable, and the survey's
      approach gets there) or "applies no psychoacoustic processing" (a different and much weaker requirement, and one the
      tone-overlay port already satisfies, which would make it a strange thing to ask for at the end).
- [ ] **Reuse the genetic algorithm in `reference/WebBeep/go/` rather than rewriting the parameter search.** It already
      tunes around thirty encoder and decoder parameters against decode accuracy, and `notes/success.txt` records a run
      reaching accuracy 1.0. Every parameter it searched is a parameter this port will have too, so the search is reusable
      as-is once the DSP matches. Undecided: whether the fitness function should also score audibility and false positives,
      which it currently does not.
- [ ] **A spectrogram view for a marked file**, so the mark can be seen rather than inferred. The reference has a
      `Plotter` that draws waveforms; a spectrum view is what makes a spread or masked mark inspectable, and is the
      fastest way to tell a DSP bug from a codec bug while debugging.
- [ ] **Ask what the marker signal ("Ident") in the reference spec section 6.1 became.** It proposes a short fixed string
      before the payload to make the start findable in noise, and says the current algorithm could carry it by running over
      multiple messages. That is the synchronisation problem the port will hit anyway, so it may be worth reading as a
      proposal rather than as future work.
- [ ] **Whether `reference/WebBeep` should stay in the repository once the port is done.** It is 122 files and about 11,000
      lines of Java that fluidmark will have replaced. Keeping it makes a cross-check possible forever; dropping it makes
      the repository one language. It is Danny's own work either way, so the decision is about whether the port keeps
      consulting it, not about its history.
- [ ] **Whether the encode page keeps its 63-character limit.** The previous version split longer text with
      `TextSplitter` and encoded each part, appending the tones. That is a workaround for a payload rate too low for a URL,
      and it produces one long file rather than several marks. Carry it over as behaviour for the port, and treat changing
      it as part of the payload format decision.
- [ ] **The previous site's audio directory** (`reference/WebBeep/www/audio/`) holds MP3s the old service generated from
      real user payloads, including `ISP_loveSP_you!.mp3`, which looks like a real use. They are the only real marked
      files anywhere in the repository and therefore the best decode test material available, better than anything
      synthesised. Copy them into a test fixture directory before porting, and check what they decode to.
- [ ] **A tool that would help goes in [HUMANS.md](HUMANS.md)**, not here.