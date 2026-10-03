# Humans

Actions only a person can take, and the tools that would let an agent do them instead. Not a counterpart to
[AGENTS.md](AGENTS.md): anything that is guidance rather than an action belongs there, and anything an agent can do itself
does not belong here at all.

Keep this short. An item here is something the work is waiting on.

## Putting an update on the live server

On the server, from the repository root:

```sh
npm run deploy
```

It pulls, builds the image, runs it on a spare port and checks it serves, and only then replaces the live container
(`fluidmark` on `127.0.0.1:8080`) and checks again. A bad build leaves the live site alone, and a failure after the swap
puts the previous image back. `bin/deploy.js` says what it did, and exits non-zero on any failure.

- The site is down for a second or two during the swap.
- Options after `--`: `--no-pull` to deploy what is checked out, `--name`, `--port` and `--spare-port` if 8080 or 8099
  is taken (change the `proxy_pass` to match).
- Host nginx needs no reload unless `strandz.it.conf` itself changed (`nginx -t && systemctl reload nginx`).
- HTML and the Wasm are `no-cache`, so a refresh picks them up; the stylesheet is cached for an hour.
- It checks the container, not the domain. Afterwards, open `/fluidmark/`, hard-refresh, check the browser console for
  errors, and check that `/`, `/jigdaw/`, `/diddums/` still answer as before (`docs/web.md`).

## 1. Checks that need a person

- [ ] **Push, and read the first CI run.** `.github/workflows/ci.yml` has never run. Expect the macOS and Windows jobs
      to need a fix or two (see "Continuous integration" in `docs/vst.md`); paste the failing log and it can be
      corrected. Then, with a real Mac and a real Windows machine, load the downloaded bundle in a DAW and say whether it
      loads and marks (`node bin/mark.js --read` on a bounce). On macOS an ad-hoc-signed download is quarantined:
      `xattr -dr com.apple.quarantine FluidMark.vst3`. Real distribution wants an Apple Developer ID and notarisation, and
      a Windows code-signing certificate, which are yours to obtain.

- [ ] **Try the Mark plugin in REAPER.** `./install.sh` and
      rescan. Put **FluidMark** last in the master chain, type an identifier in the plugin window (click the field, type,
      Tab to the key field), play, and bounce. Then `node bin/mark.js --in bounce.wav --read` (with `--key` if you gave
      one) should print the identifier. Things to watch for and tell me: whether the window opens and the text fields
      take typing and Backspace and paste, whether Space still plays and stops while a field has focus, whether the
      latency is compensated (a track with the plugin on should stay aligned with one without), whether a bounce and a
      second bounce are identical, and whether a long bounce reads. This is the first time it has met a real host.

- [ ] **Listen to the port, against the original.** Run the reference encoder and fluidmark's, play both against the same
      unprocessed audio, and say whether they sound like the same thing. The comparison needs two people who know what the
      reference is supposed to sound like, which is one. Nothing in the suite can hear anything, and a port that decodes
      correctly can still sound plainly wrong.
- [ ] **Try the page on a phone, with a long stereo file.** The marker needs about 1.2 GB for six minutes of stereo and
      nothing has run it on a phone. See what happens at three minutes and at ten.
- [ ] **Listen to the mark, and say at what margin you hear it.** The default now shapes the mark to sit 6 dB under a
      modelled masking threshold. A model is not a listener, and this is the one measurement with no proxy. Pick a track
      with a quiet passage as well as a loud one, then:
      `node bin/audibility.js --in track.wav --strengths -3,-6,-9,-12` prints, for each margin, where the model thinks the
      mark is closest to being heard (the "worst frame" time). `node bin/mark.js --in track.wav --payload x --out
      marked.wav --key k --strength -6` writes a marked file (the track has to be long enough, and it says how long).
      Play it against the original at that time and at the quietest passage, then try `--strength 0` and `-3` to hear
      what a louder one sounds like and `-12` for a quieter one. Say the loudest margin at which you cannot tell. Also
      try `--level relative --strength -20` once, which is what the project used before, for comparison.
- [ ] **Listen for the mark once there is an inaudible embedding.** Whether the mark is audible is the question the whole
      project turns on, and it is the one measurement with no proxy. Play at a level a listener would actually use, on
      material with a quiet passage as well as a loud one, since a masking threshold that holds on one may not on the other.
      Say where it becomes audible rather than only whether.
- [ ] **Decide the audibility criterion**, once there is something to measure: a level, a method, and the point at which
      it stops being acceptable. This is a judgement about people listening, not about samples.
- [ ] **Try the VST plugin in a DAW.** Its core is testable headlessly, but whether it sits acceptably in a mastering
      chain, whether the generated pattern is something you would keep as a bassline, and whether a parameter change moves
      a note already sounding are questions only a DAW answers. Fluidmark is not a plugin toolchain, so nothing here is set
      up to try one.

## 2. Tools that would help
**`pluginval`, or the VST3 SDK's validator**, for the Mark plugin (`docs/vst.md`). It loads a built bundle the way a host
does and tries the things hosts do that a test of the engine does not: odd block sizes, a sample-rate change in the middle,
a state save and restore, parameter automation. Without it the only check of the wrapper is a person loading it in a DAW,
which is slow and catches less. Not installed here; `carla` and `jackd` are, and REAPER is in use (there is a
`vst-test.RPP` under `~/Music`), so the manual check has somewhere to happen in the meantime.

**A DAW**, for the same reason as the item above: the plugin has to be tried in one, and
installing and configuring a host is a person's action.

**A browser automation connection, needed for the front end.** For checking page layout, focus, pointer and viewport
width, which no test suite can see: a DOM without a renderer has no layout, no pointer capture to fail, and no
`activeElement` to lose, so those failures pass every unit test. The front end needs this from the first page, not later,
since accessibility and narrow layout are both only checkable in a real browser. If a browser connection is wanted, ask
before falling back to a workaround: the tool may simply need starting, and a silent workaround can end up standing in
for a check that never ran.

**A narrow layout check is now automated** — `www/browser-check.js` measures `scrollWidth` against
`innerWidth` at 360px in headless Chrome, checks every visible target is at least 44px, and checks
text inputs compute to 16px. What it cannot do is judge the result, so the parts below are still
owed.

**Real key presses, not scripted focus.** `browser-check.js` focuses each control in turn to prove
it is focusable at all, which is not the same as the tab order being right. Press Tab through both
forms with real hands: the skip link first, then the header links, then the identifier field, the
scheme menu, the file input, the button, then the second form.

**A narrow layout check, in a real browser, once the front end is built.** Load the page at phone
width and compare `documentElement.scrollWidth` with `innerWidth`; they should match, or match
within a pixel. This cannot be done from a DOM without a renderer, and the tests cannot see it: the
page has no layout until something lays it out. `clientWidth` includes padding, so it is the wrong
number to compare against, and an element outside the document measures zero. What to check
individually: every target at least 44px, the text input at least 16px, and no horizontal scrolling
at 360px.

**A real screen reader pass over the two forms**, when the front end is built. Both operations are a text field and a file
input plus a result, so the check is short and specific: is the field labelled, is the chosen file announced with its name,
is the result announced when it arrives, and is an error distinguishable from an empty result by ear alone.

**A wasm runtime under a profiler, or `wasmtime`, for the DSP.** Not needed to build, useful once the Goertzel loop and the
filters are hot: a decode of a long file is the first thing that will be slow, and knowing which half is slow is cheaper
than guessing. `wasmtime` also gives a second runtime to check a memory-ownership bug against, since the browser and node
disagree about what a detached view does.

**An `ffmpeg` or `lame` binary, for the lossy round trip.** Both are on this machine already, so this one may be struck.
The reference shells out to LAME for its MP3 step, and a real lossy codec is the interference that matters most for a
watermark, since a stub encoder would pass a test that says nothing.