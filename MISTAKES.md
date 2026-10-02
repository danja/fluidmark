# Mistakes

What happened, root cause, prevention. Grouped by lesson rather than by date, newest first inside each. A lesson that lives
in [AGENTS.md](AGENTS.md) is a pointer, a fix held by a test alone is dropped, everything else is below.

Nothing yet. The project has no source, so no mistake has been made in it to record. The lessons below are carried over
from sibling repositories and from reading the reference implementation, because they are the ones most likely to recur
here, and because arriving with them already named is cheaper than arriving with them to be learned. Each says what would
notice it happening.

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