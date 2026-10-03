# Mistakes

What happened, root cause, prevention. Grouped by lesson rather than by date, newest first inside each. A lesson that lives
in [AGENTS.md](AGENTS.md) is a pointer, a fix held by a test alone is dropped, everything else is below.

Newest first within a theme. Some entries are lessons carried over from sibling repositories and from reading the
reference implementation, because they are the ones most likely to recur here; the rest are this project's own. Each says
what would notice it happening.

## A script used a global that only the newest Node has

**What happened.** CI's web check died with `WebSocket is not defined` in `www/browser-check.js`. `package.json` says Node
20 or later; the global `WebSocket` arrived in Node 22, and the development machine runs 25.

**Root cause.** Only ever run on one Node version, newer than the declared minimum. The same class as the entry below: it
passed on the machine that wrote it.

**Prevention.** Run scripts under the declared minimum (`npx -y node@20 ...`) before claiming support for it. The script
now falls back to the `ws` devDependency.

## A test read gitignored reference files and passed only on the one machine that had them

**What happened.** The first CI run failed in `tests/mp3.test.js` with ENOENT on `reference/WebBeep/www/audio/`. The
reference is gitignored, so a clean checkout does not have it; `tests/reference.test.js` skipped for that reason, but
`mp3.test.js` read the directory unconditionally and three of its tests used a file from it.

**Root cause.** Every run until then was on the one machine that has the reference. The suite was never run on a clean
checkout, so "passes" meant "passes here".

**Prevention.** Tests that need local material declare a skip (`describe.skipIf` / `it.skipIf`), so the run reports
skipped and not green. Before trusting a suite, hide `reference/WebBeep` and run it: that is the CI environment.

## The script was cached for an hour, and the modules beside it were not

**What happened.** `deploy/nginx.conf` revalidated the HTML, the modules under `/src/` and the Wasm, and cached everything
else in `www/` for an hour, on the reasoning that what was left was stylesheets and images. `app.js` was in what was
left. After a deploy a browser would run the old `app.js` against new modules, which is a stale page that loads and
then calls something that is not there, with nothing in any log. The browser check found it by accident: it keeps a
Chrome profile between runs, an old `app.js` came out of that cache, and a new check failed with the old page's text.

**Root cause.** A cache rule written for the file types I expected, not for what the page's code depends on. The
deployment rules in `AGENTS.md` name exactly this failure ("a stale cached page against a new Wasm build") and I wrote
the policy anyway without testing it.

**Prevention.** `tests/web.test.js` parses the real nginx config, picks the location nginx would pick for each URL the
page loads, and requires `no-cache` on every one; it fails with the script moved back under the cached rule, and it
keeps a regex location from shadowing `/src/`. `bin/deploy.js` checks the headers on the running container. The rule is
that anything the page's code depends on is revalidated, and the cached set is images only.

## One key measured the key, not the scheme

**What happened.** Every spread-spectrum measurement used one key, the public default. Marking a stereo file with a
typed phrase then failed to read, and on a real recording 9 keys in 14 could not read their own mark. The sync
threshold (5 standard deviations) sat almost on the ceiling a perfect mark can reach (sqrt(32), about 5.7), so a key
passed or failed on how its sync word's sidelobes happened to fall. The default key passed. The "thin 3 dB margin" I had
written up, and the cliff in the strength sweep, were mostly this.

**Root cause.** A threshold was picked by feel, and a single key was the whole population of the test. The spread it was
measured against includes the data bits, so it grows with the mark and the ratio cannot rise past a fixed ceiling.

**Prevention.** A scheme parameterised by a key is tested over many keys, not one. The test runs sixteen on a host whose
level moves, and a second one asserts the threshold sits well below the ceiling; both go red with the old value. A
threshold has a derivation next to it, and a measured margin is re-measured after any fix to the thing it measured.

## An MP3 parser written from memory read none of the files the page exists for

**What happened.** The page's MP3 path was never run in a real browser until stereo made it matter. It had four
separate faults: it rejected MPEG-2 (the 22.05 kHz mono files the old service wrote, which are the whole reason the page
reads MP3), used the Layer I bitrate table for Layer III, hard-coded the sample rate to 22050 and the channel count to
1, and called `AudioBuffer.getChannelData` on an `AudioData`, which has no such method.

**Root cause.** The code was written against how MP3 works in general and never against a file. No test could reach
`AudioDecoder`, so nothing failed.

**Prevention.** The parsing moved to `src/mp3.js`, which is pure and is tested against the real files the old service
made and against ffmpeg's. The decode is checked by `www/browser-check.js` in headless Chrome, with a stereo MP3 and a
legacy MP3 through the page's own controls. Code that needs a browser is not done until it has run in one.

## A relative URL can still escape the prefix it is served under

**What happened.** On the live page at `strandz.it/fluidmark/`, choosing a file did nothing and the input stayed on
"No file chosen". `www/app.js` imported `../src/load-browser.js`. From `/fluidmark/app.js` that resolves to `/src/...`,
which the front door sends to a different app. The import failed, the module never ran, and the page rendered fine
with every handler missing. The unit tests, the markup tests and the container check all passed.

**Root cause.** The prefix tests looked for a leading slash, on the reasoning that relative URLs are safe. A relative URL
with `../` is relative to a directory that only exists in the container's own layout, and the prefix is one level
that the container never sees. The container served `/src/` correctly at its own root, so every check against
`127.0.0.1:8080` passed.

**Prevention.** `tests/web.test.js` now resolves the whole import graph from the URL the page is really served at
and requires every module to land under `/fluidmark/` on a file the container serves. It was broken on purpose to
confirm it goes red. The deployment check also has to be run against the real domain, not only the container: it is the
only place the prefix exists.

## A figure computed from nothing reads as a measurement

**What happened.** `bin/attack.js` computed the bit error rate of a row as `errors / bits` and printed it
as a percentage. For the spread-spectrum scheme, a row where no sync was found has no bit error rate,
so the code stored `null`, and the print line did `null * 100` and showed `0.0%`. A lost mark rendered
as a perfect one in the BER column, beside "no (no mark found)" in the next column. I read three sweep
tables with it before noticing, and counted the outcomes from the right-hand column by luck.

**Root cause.** A string replacement meant to render `null` as `n/a` did not match the line it was
aimed at and failed silently, and the next run looked fine because the other column was right.

**Prevention.** A cell that can be "not applicable" is checked by running a case where it is. The harness
now has such a case in every table (a lost row), and I looked at the cell instead of the count.

## A host too easy for the scheme flatters the scheme

**What happened.** The first harness run on the new spread-spectrum scheme read 21 of 22 rows, including
removal rows it had no business surviving. The host was `src/synth.js`, a few decaying harmonic notes. On
real audio the same scheme read 17 and 18 of 20, and the margin was 3 dB, not the 10 or more the
synthetic table suggested.

**Root cause.** A tonal host leaves most of the band empty, so a mark in it is easy to read. This is the
"fake more permissive than the real thing" lesson below, in its audio form, and it was already written down
in `AGENTS.md`. I wrote the generator, ran the harness, and was impressed, in that order.

**Prevention.** The harness is run on real audio before a figure is recorded, and the host and its level are
named beside every table. `synthTrack` stays as a deterministic test fixture, and its tests say what it is
not. A result that looks like a breakthrough on the first run is a reason to look for what is too easy.

## A guard is only as wide as the list it walks

A check that reads a list, a directory or a config file is right about the rule and wrong about the population more often
than it is wrong about the rule. Three guards in one sibling repository were each correct about what they checked and each
missed new code, nodes without routes, and a list it should not have governed.

Prevention: when adding a guard, write down what it walks and ask what is outside that set. A guard that cannot run is worse
than no guard, because it looks like coverage, so break the thing it guards on purpose and watch the guard go red. A guard
must never depend on the thing it guards.

## A fake more permissive than the real thing turns a specification error into a passing test

A stand-in for a platform API is worth having only where it refuses what the real one refuses. A sibling repository's fake
`MessagePort` handed over a value the real one silently cannot deliver, so hundreds of passing tests, including an
end-to-end one, said nothing about a page that failed on its first real load. A fake `fetch` passed for the same reason.

Prevention: when writing a fake, ask what the real API forbids, not only what it returns for ordinary input. Mutation test
each one by reverting the fix and watching the suite fail the way the browser did.

## A change in one file usually needs a second file to change with it, and nothing connects them

Adding a runtime dependency on a path, a value or a list leaves whatever else has to agree with it untouched. The
population is usually larger than the rule stated.

Prevention: find what else has to agree, and write the test that binds them. A test asserting that two lists match is worth
more than either list being reviewed carefully.

## A rule worth stating is worth a test

A rule nothing checks will be broken, and nobody will notice until it has been broken many times. A rule stated here that
nothing enforces is a sentence, not a guard.

Prevention: when adding a rule, ask what would notice it being violated. If the answer is "a careful reader", write the
check instead.

## A sentence about the system is a claim, and nothing tests sentences

Take every figure from the system rather than from memory: a `curl`, a count, a `grep -c`. Where prose is a commitment,
bind it with a test.

Prevention: no figure in a document survives a change to the code unless something checks it.

## A screenshot or a browser run that checks nothing measures the default

An experiment that does not check what its calls returned measures whatever the default was, and reads as a result. In one
sibling repository an A/B comparison compared a setting with itself because every call had failed and the result was
ignored; it nearly became a reported defect.

Prevention: a scripted browser step asserts success on every call and throws. A measurement gets a positive control and
records how many samples it took. `AGENTS.md` requires running the program after any change to imports, wiring or startup,
for the same reason: the suite does not catch that class of failure.

## An allocation that did not cover its own header wrote over the next one

**Found by the first run of the FFI boundary tests, and it was a heap overflow in new code.**
`core_scratch_new` allocated `SCRATCH_BYTES` (8) but wrote a `HEADER_BYTES` (16) header into
the allocation and returned `base + 16`, so the header sat entirely past the end of what had
been reserved. The allocator then placed the next buffer inside those 16 bytes, and every
out-parameter write landed on that buffer's header.

The symptom was a `core_buffer_free` reporting `CoreMagicError` on a buffer that had just been
written and read back correctly. Nothing upstream was wrong: the tracked length was right, the
samples were right, and the free of that same pointer failed. Two hypotheses were wrong first,
in order: that `memory.grow` had detached something, and that the static data segment occupied
low addresses. Both were reasonable and both were wrong, and what separated them was printing
the sixteen header bytes before and after each call, which showed the magic changing from
`314b4d46` to `03000000`, the length, written at an address that belonged to something else.

Prevention: a header inside an allocation means the layout must cover the header. Where a host
and a core each keep a copy of a buffer's length or capacity, add a way to ask the core what it
believes. The two agreeing is a check, and the two disagreeing is a bug report that names its own
cause. `core_buffer_capacity` exists for that reason and did not exist when the bug was found.

## A test that passes while the bug in its own comment is present

The test added for the overflow above, "survives out-parameter writes", passed with the bug
reintroduced. It asserts that out-parameter writes do not disturb buffers, over eight buffers
and four rounds, which sounds thorough and caught nothing: which allocation gets hit depends on
where the allocator places the neighbour, and on this machine the buffer in the earliest test is
the one that takes it.

Prevention: a property test is not a guard until it has been seen to fail against the real
defect. Reintroduce the bug and watch the named test go red, or state plainly in the comment
that the guard is elsewhere, because a test whose comment claims a protection it does not give
is worse than no test.

## A null check silently turned a valid buffer into a zero result

**Found and measured while designing the FFI boundary, before any of it is built.** A Goertzel
function exported as `extern "C"` was called from Node with a pointer to offset 0 of the
module's memory. It returned 0.0 where the same call at any other offset returned the correct
power. The cause was in the guard:

```rust
if buf.is_null() { return 0.0; }   // address 0 is a real address
```

Address 0 is a legitimate location in a Wasm module's linear memory, so `is_null()` on a
caller-supplied pointer is not a validity check. It converts "the start of memory" into "no
data", and it returns a plausible number rather than failing, so the symptom is a wrong
measurement rather than a crash.

Prevention: the core allocates and hands out pointers, and a caller never invents an offset.
Where there is state, pass an opaque handle rather than a bare pointer. Where a length is known,
check it against what was allocated. A guard that returns a sensible default on bad input hides
the bad input, and this one would have been read as a DSP bug.

## The FFI call was written wrong twice before it worked

The same experiment: calling `goertzel(ptr, len, hz)` from Node, I passed two arguments instead
of three, then relied on a null guard to absorb the result. Both produced a number, neither
produced an error, and both would have looked like a decoder that finds nothing in every file.

This is the ordinary experience of a pointer API, and it is why `docs/ffi.md` puts the whole
ergonomics layer in JavaScript: typed arrays instead of pointers, an object instead of new and
free pairs, and `.d.ts` types over the raw exports so the call site is checked.

Prevention: the raw boundary is for C++ and for the wrapper, and host code never calls it
directly. A call site that has to remember an argument order is a call site that will get it
wrong.

## The container served the Wasm module as a web page, and nothing said so

**The first deployment check caught this, which is the only reason it is a paragraph and not an
outage.** `root` in the nginx configuration was `/srv/www`, and the module lives at
`/srv/build/fluidmark_core.wasm` because it is shared with the Node tools rather than being part
of the site. So `/build/fluidmark_core.wasm` resolved to `/srv/www/build/fluidmark_core.wasm`,
which does not exist, and nginx served the 404 page — as `text/html`, with a 200 in some setups
and a 404 in this one. The browser was handed an HTML page where it expected a module.

`/src/` was broken the same way. Both needed an explicit `alias`.

This is worth writing down because every layer reported success: the build copied the file, the
container started, `/healthz` answered `ok`, and the index page loaded. Only `curl -I` on the
module's own URL showed the content type was `text/html`.

Prevention: after anything is deployed, request the thing that is most likely to be served with
the wrong type, by its own URL, and look at the status and the content type. A health endpoint
proves the process is up; it says nothing about what is being served. The content type of a Wasm
module is the check, because `application/wasm` or the browser silently falls back to compiling the
whole module as an `ArrayBuffer` — slower, and not an error.

## A screenshot path is a build step

A screenshot that nobody looks at until something looks wrong is a step that was broken for as long as nobody checked. In
one sibling repository every gallery screenshot since a stylesheet moved was of an unstyled page, and the committed PNGs
that looked correct predated the move.

Prevention: look at generated output when it is generated, not only when it is suspected.

## A checksum that reports a failure and carries on anyway

**The reference implementation's `Checksum.checksum` computes the check, finds it does not match, logs "Checksum failed!",
and returns the string regardless.** The throw is commented out. So a decode that read the payload wrong reports success,
and every accuracy figure derived from it is an upper bound on a number that was never checked.

This is the mistake most likely to be inherited by accident, because copying the behaviour is the faithful port and
copying the behaviour also copies the hole in it. It is in MISTAKES.md now so the port can decide deliberately rather than
by omission.

Prevention: a checksum that fails is a failure. Do not carry a check forward in a state where it can be observed failing
and ignored. If the port needs a non-fatal mode for a reason, name it and say what the caller gets instead of a payload.

## A page rewritten by string substitution in a server handler

**The previous site's encode handler returned `index.html` with one sentence replaced.** `EncodeHandler` read
`www/index.html` into a string at startup and did `newPage.replaceAll("<p>Try it out</p>", replacement)`, where the
replacement was a hand-built `<a href>` to the generated MP3 it had just written.

This is the mistake the front end is most likely to inherit, because porting the handler faithfully means porting the
substitution. It breaks the moment the page changes: the sentinel is a sentence in the middle of a paragraph, so editing
the copy for clarity silently turns every encode into a page carrying no result, and nothing anywhere reports it. There is
no error, because `replaceAll` on a string that does not match returns the string unchanged.

Prevention: a page renders from state in the browser. If something must substitute text into markup, it substitutes into a
placeholder it owns, and a test asserts the placeholder still exists, because a placeholder that stops existing is
invisible from every layer above it.

## A collection type was doing load-bearing work nobody had written down

**Found while porting the reference's pitch finder: its `HashSet<Double>` is not incidental.**
The reference's tone table repeats six frequencies, each twice, distinguished only by duration.
`GoertzelPitchFinder` iterates all 24 table entries, so a frequency that appears twice is
computed twice and reported twice, and the character decoder infers a tone's duration from how
many pitches it found: two means both ran long, none means both ran short, one means they
differ. Reporting 24 indices instead of distinct frequencies makes that count never match.

The port's first version reported table indices, faithfully, and every character decoded to
garbage. "abc" came back as `[17, 18, 19]`: the low nibble right, the high nibble consistently
wrong, because the low note resolved to the first of two entries sharing its frequency.

Prevention: when porting, ask what each data structure in the original is *for*, not only what it
contains. A `Set` where a `List` would do is a claim, and the claim here was deduplication. Where
the claim matters, say so in the port's own words, because a reader who does not know it was
deliberate will "simplify" it back into a list and lose every character.

## The parameters in the constants file were not the parameters that worked

**The reference's round trip does not work with the defaults in its own `Constants.java`.**
`gThreshold` is 10000 there and 4194.9 in `data/config.xml`; `cropProportion` is 0.5 versus
0.6338; `silenceThreshold` is 0.5 versus 0.393; and `Decoder.core.normalise.on` is false in the
configuration the service actually ran with.

The mechanism: normalising to +/-1 and then cropping at a threshold of 0.5 trims the envelope
ramps off the front and back of the tones. That shifts the decoder's crop grid off the encoder's
slot grid by however long the ramps are, and every character after the first is read from the
wrong place. Turning normalisation off and thresholding at 0.393 against the raw signal, whose
tones sit at amplitude 0.49, makes the crop find the true first and last tone sample.

So the genetic algorithm's output is not tuning, it is part of the algorithm. It is carried in
`wasm/src/tables.rs` as the defaults, with the `Constants.java` values recorded alongside so a
change to either is visible in a diff.

Prevention: when porting, find the configuration the reference actually ran with and compare it
against the defaults in its source, before writing any pipeline. A default nobody exercised is a
value somebody guessed.

## Two copies of a length, and the copy that was read was the stale one

**The JavaScript wrapper read its own idea of a buffer's length after the core had changed it.**
`readBuffer` returned `new Float32Array(buffer.length)` from a field the wrapper kept, while
`core_encode` sets the length on the core's side of the boundary. So marking a payload produced
an empty array, every read failed, and the error named the length rather than the wrapper.

The symptom was a `CoreLengthError` from an output buffer that had just been filled, and then a
`RangeError` from a test that only wanted to look at silence. `readBuffer` now asks the core,
which is one call and removes the class of bug rather than this instance of it.

Prevention: on a boundary, one side owns each fact and the other asks. This is the same lesson as
`core_buffer_capacity`, reached from the other direction, and the two together are why both
length and capacity can be read back from the core.

## The fragile parts of a reference are the parts a port should record rather than repair

Found by reading `reference/WebBeep`, not by running it. Four places where the reference depends on a coincidence:

- `CharacterDecoder.decodeChar` compares frequencies for exact `double` equality against the tone table
  (`note == freqs[i]`). This works only because `GoertzelPitchFinder` reports table values rather than measured ones, so
  the equality is between two copies of the same constant and measures nothing.
- `Maps.findNearestNote` initialises `nearestNote` to 0 and starts its loop at index 1, so index 0 is never considered
  and the result is 0 for anything below half the lowest table frequency. Only `FFTPitchFinder` calls it;
  `GoertzelPitchFinder`, the default, does not, which is why the bug has stayed invisible.
- `Cropper.findStart` returns -1 when nothing crosses the threshold, and `subList(-1, end)` then throws. The exception is
  caught, "DETECTOR problem" is printed, and the input is returned **uncropped**. A decode that cannot find the start of
  the mark therefore continues on a shifted grid rather than failing, and every chunk after that point is misaligned.
- `Chunker` derives its chunk grid from `Constants.TONE_DURATION` and depends on the decoder's start offset landing
  within that grid. A comment in the source notes silence between tones is not handled correctly.
- `Chunker.process` pads the chunk list with a silent dummy chunk when the count is odd, marked in the source as an "UGLY
  HACK", and `ASCIICodec.chunksToASCII` then decodes it as a real character. The trailing character of an odd-length
  payload is therefore not meaningful.

Prevention: when porting, write each one down in `docs/port.md` with the test that would notice it changing. The point is
not that the reference is wrong. It is that these are load-bearing coincidences, and a reader who does not know they were
deliberate will change one and lose a week to why decoding stopped working.
## A rejection sampler that is correct and quadratic

**Found by the LSB baseline hanging the test suite, and it would have been a denial of service in
a tool rather than a slow test.** Choosing distinct sample positions by drawing and rejecting any
draw at or below the highest already drawn is Knuth's method, and it is correct. It is also
quadratic when you want a small fraction of a large range: pushing the highest toward the limit
means rejection probabilities climb, so drawing 336 positions out of 44100 hit the limit after about
nine and then rejected almost everything forever.

It is fine when drawing most of the array, which is why it survives review and why my first two
tests, which used 64 positions out of 64 and 2000 out of 10000, both passed. The case that matters
is the realistic one: a short payload in a track's worth of samples.

Replaced with a sparse Fisher-Yates, which costs O(count) and stores only the swaps. The test
that now covers it is `a_small_fraction_of_a_large_range_comes_out_promptly`, and the note above
the type says why, because the next person to see a rejection sampler here will think it is fine.

Prevention: when the quantity is a fraction of a large range, ask what the method costs when the
fraction is small, and write a test at that ratio rather than at the one that is easy.

## "The low bit of a float" is not a thing, and the test that would have said so was the one I skipped

**The LSB baseline embedded into a sample's fractional part and read it back, and every bit came
back as 1.** A float's low bit lives in its mantissa, and a decoder reading `round(fraction * 2)`
sees nothing of it: the value written as `0.0` or `1.0` fractional is a full-scale difference, not
a bit.

The fix is to work in the 16-bit integer a WAV actually stores, which is where the survey's "low
order sample bits" live. The lesson is narrower than "be careful with floats": the failure was
caught by a round-trip test, and the round-trip test I did not write was the one that mattered. The
pair "embed, then read back your own bytes" is the cheapest test for a whole class of scheme bug,
and it is the first thing to write.

Prevention: for any embedding, the first test is a round trip on unmodified audio, asserted on the
bytes rather than on the payload. A scheme that cannot read back its own bytes has no chance
against anything else.

## A scheme that needs the reader to know the payload length cannot be read by a tool

The LSB baseline has no sync word: the reader is told how many bytes to read through
`extract(..., payloadBytes)`. That is workable for a harness and impossible for a user, who has a
file and no idea what length to ask for. It is in `watermark.js` as an explicit `TypeError` rather
than a default, so the limitation is visible at the call site instead of producing a plausible
short answer.

Prevention: a scheme's first question is how a reader finds where the mark starts, and that is a
requirement on the scheme rather than a detail of the caller. Asking it while writing the framing
is cheaper than discovering it after the whole scheme is built.

## A key protects a payload from being read, and nothing from being written

**Asked directly, and the answer turned out to be the more important result of the whole
watermark work so far.** How would you remove a mark from a FluidMark-marked file?

The measured answer: set the low bit of every sample to zero. It takes no key, needs no knowledge
of where the mark is, and costs nothing a listener would hear — every sample moves by at most one
16-bit step, about 0.003% of full scale. The mark is gone. Randomising those low bits instead works
the same way.

The key is what stops anyone *reading* the payload, which is a confidentiality property. It is not
an integrity property and never was: an attacker who wants the mark gone does not need to decode
it, only to destroy the region it lives in. A secret that protects a thing from disclosure and not
from alteration is not a secret in the sense people assume.

This is now two rows in the harness (`bin/attack.js`, the `REMOVE` rows) and four Rust tests,
because a scheme whose mark survives a keyless scrub has said something worth knowing and one whose
mark does not has said something worth recording. It is also the argument for the work still to do:
redundancy, error correction and interleaving raise the cost of removal from "one pass with a
scrubber" to "destroy most of the signal's energy in the marked bands", which is damage a listener
will hear. That is not permanence either, and nothing is. It is the difference between a mark and a
promise.

Prevention: whenever a key is introduced, ask what it protects against. If the answer is only
disclosure, say so in the same breath, because "keyed" reads as "protected" and will be assumed to
mean both.

## A remover that truncated the samples instead of clearing one bit

The first version of `scrub_low_bits` was `(x - sample_fraction(x)).trunc()`, which floors a sample
rather than clearing its low bit, so it moved samples by up to their own amplitude: 0.4 on the test
signal. It still removed the mark, which is exactly why it was nearly a silent failure — the test
that mattered asked whether the mark was gone and the answer was yes.

Caught by the test asserting that removal leaves the audio alone, which is the assertion that says
what a *removal* attack is supposed to look like as opposed to a *destruction*.

Prevention: an operation's observable side effect is part of its contract. Ask what else it changes,
and check that too, especially when the operation's whole point is to be quiet.
