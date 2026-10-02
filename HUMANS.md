# Humans

Actions only a person can take, and the tools that would let an agent do them instead. Not a counterpart to
[AGENTS.md](AGENTS.md): anything that is guidance rather than an action belongs there, and anything an agent can do itself
does not belong here at all.

Keep this short. An item here is something the work is waiting on.

## 1. Checks that need a person

- [ ] **Listen to the port, against the original.** Run the reference encoder and fluidmark's, play both against the same
      unprocessed audio, and say whether they sound like the same thing. The comparison needs two people who know what the
      reference is supposed to sound like, which is one. Nothing in the suite can hear anything, and a port that decodes
      correctly can still sound plainly wrong.
- [ ] **Listen for the mark once there is an inaudible embedding.** Whether the mark is audible is the question the whole
      project turns on, and it is the one measurement with no proxy. Play at a level a listener would actually use, on
      material with a quiet passage as well as a loud one, since a masking threshold that holds on one may not on the other.
      Say where it becomes audible rather than only whether.
- [ ] **Decide the audibility criterion**, once there is something to measure: a level, a method, and the point at which
      it stops being acceptable. This is a judgement about people listening, not about samples.

## 2. Tools that would help

**A browser automation connection, needed for the front end.** For checking page layout, focus, pointer and viewport
width, which no test suite can see: a DOM without a renderer has no layout, no pointer capture to fail, and no
`activeElement` to lose, so those failures pass every unit test. The front end needs this from the first page, not later,
since accessibility and narrow layout are both only checkable in a real browser. If a browser connection is wanted, ask
before falling back to a workaround: the tool may simply need starting, and a silent workaround can end up standing in
for a check that never ran.

**A real screen reader pass over the two forms**, when the front end is built. Both operations are a text field and a file
input plus a result, so the check is short and specific: is the field labelled, is the chosen file announced with its name,
is the result announced when it arrives, and is an error distinguishable from an empty result by ear alone.

**A wasm runtime under a profiler, or `wasmtime`, for the DSP.** Not needed to build, useful once the Goertzel loop and the
filters are hot: a decode of a long file is the first thing that will be slow, and knowing which half is slow is cheaper
than guessing. `wasmtime` also gives a second runtime to check a memory-ownership bug against, since the browser and node
disagree about what a detached view does.

**An `ffmpeg` or `lame` binary, for the lossy round trip.** The reference shells out to LAME for its MP3 step. A real lossy
codec is the interference that matters most for a watermark, and a stub encoder would pass a test that says nothing.