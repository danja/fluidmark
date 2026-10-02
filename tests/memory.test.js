// tests/memory.test.js
//
// The memory hazard, tested rather than described.
//
// `memory.grow()` detaches every existing view on the memory. A detached view does not throw
// when read: it reports length 0. So a cached view across a grow silently becomes an empty
// buffer, and a measurement built on it comes back as zero, which reads as "the mark is not
// there" rather than as a bug.

import { describe, expect, it } from 'vitest';
import { floatView, growMemory, isDetached, uint32Out } from '../src/memory.js';

function memoryWith(bytes) {
  return new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) + 1 });
}

describe('views over core memory', () => {
  it('read and write the bytes they describe', () => {
    const memory = memoryWith(1024);
    const view = floatView(memory, 0, 4);
    view.set([1, 2, 3, 4]);
    expect(Array.from(floatView(memory, 0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('are not affected by another view over the same memory', () => {
    const memory = memoryWith(1024);
    floatView(memory, 0, 4).set([9, 9, 9, 9]);
    // Bytes 16 onwards are past the four floats just written, and still zero.
    expect(Array.from(floatView(memory, 16, 2))).toEqual([0, 0]);
  });
});

describe('growing memory', () => {
  it('detaches a view held across it, and the detached view reports zero rather than throwing', () => {
    const memory = memoryWith(65536);
    const held = floatView(memory, 0, 4);
    held.set([1, 2, 3, 4]);
    expect(held.length).toBe(4);

    growMemory(memory, 1);

    // Reading a detached view does not throw. It reports zero length, which is the whole
    // reason this hazard is easy to miss.
    expect(() => held[0]).not.toThrow();
    expect(held.length).toBe(0);
    expect(isDetached(held)).toBe(true);
  });

  it('leaves a view derived afterwards correct, which is why they are never cached', () => {
    const memory = memoryWith(65536);
    floatView(memory, 0, 4).set([1, 2, 3, 4]);
    growMemory(memory, 1);

    const after = floatView(memory, 0, 4);
    expect(after.length).toBe(4);
    expect(isDetached(after)).toBe(false);
    expect(Array.from(after)).toEqual([1, 2, 3, 4]);
  });

  it('does not lose data that was written before the grow', () => {
    const memory = memoryWith(65536);
    floatView(memory, 0, 4).set([5, 6, 7, 8]);
    growMemory(memory, 4);
    expect(Array.from(floatView(memory, 0, 4))).toEqual([5, 6, 7, 8]);
  });
});

describe('isDetached', () => {
  it('is false for a live view, including a zero-length one over live memory', () => {
    const memory = memoryWith(1024);
    expect(isDetached(floatView(memory, 0, 0))).toBe(false);
    expect(isDetached(floatView(memory, 0, 4))).toBe(false);
  });

  it('is true only once the buffer is gone', () => {
    const memory = memoryWith(65536);
    const held = floatView(memory, 0, 4);
    growMemory(memory, 1);
    expect(isDetached(held)).toBe(true);
    expect(isDetached(floatView(memory, 0, 4))).toBe(false);
  });
});

describe('out-parameter views', () => {
  it('reads an integer the core wrote', () => {
    const memory = memoryWith(1024);
    const out = uint32Out(memory, 0);
    out[0] = 4096;
    expect(uint32Out(memory, 0)[0]).toBe(4096);
  });
});