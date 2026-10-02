// src/memory.js
//
// Views over the core's linear memory.
//
// Never cache these. `memory.grow()` detaches every existing view on the memory, and a
// detached view does not throw on access: it reports length 0, so a cached view silently
// becomes an empty buffer and a measurement comes back as zero. Deriving a view per call is
// cheap next to the DSP, and it cannot go stale. See tests/memory.test.js.

/** A `Float32Array` over `len` samples starting at byte offset `ptr`. */
export function floatView(memory, ptr, len) {
  return new Float32Array(memory.buffer, ptr, len);
}

/** A one-element `Float64Array`, for an out-parameter the core wrote. */
export function doubleOut(memory, ptr) {
  return new Float64Array(memory.buffer, ptr, 1);
}

/** A one-element `Uint32Array`, for an integer out-parameter. */
export function uint32Out(memory, ptr) {
  return new Uint32Array(memory.buffer, ptr, 1);
}

/**
 * True when `view` is looking at a detached buffer.
 *
 * A detached view reports zero length and zero byteLength, but so does a view a caller asked
 * to be zero long. Anything that keeps a view across a call which might grow memory should
 * check this and re-derive rather than trusting `length === 0` to mean "empty".
 */
export function isDetached(view) {
  return view.buffer.byteLength === 0 && view.byteLength === 0;
}

/**
 * Grow the core's memory, returning the previous page count.
 *
 * Detaches every existing view. Only for a caller that knows it holds none and will re-derive
 * afterwards; the reason it is a function here rather than a call to `memory.grow` is so that
 * there is one place in this codebase where the hazard is written down.
 */
export function growMemory(memory, pages = 1) {
  return memory.grow(pages);
}