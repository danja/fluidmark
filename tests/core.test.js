// tests/core.test.js
//
// The FFI boundary, tested before any real DSP depends on it. The buffer contract in
// particular: a length the core and a caller disagree about is a crash at best and a wrong
// measurement at worst, and neither shows up until a decoder silently finds nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore } from '../src/core.js';
import { loadCore } from '../src/load-node.js';

const RATE = 44100;

let core;

beforeAll(async () => {
  core = await loadCore();
});

afterAll(() => {
  if (core) core.destroy();
});

function sine(hz, len, rate = RATE) {
  return Float32Array.from({ length: len }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
}

/** The Goertzel recurrence, written here independently of the Rust one. */
function referenceGoertzel(samples, hz, rate = RATE) {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let sPrev = 0;
  let sPrev2 = 0;
  for (const x of samples) {
    const s = x + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = s;
  }
  return sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
}

describe('the ABI version', () => {
  it('is the one the wrapper was written against', () => {
    expect(core.abiVersion()).toBe(1);
  });

  it('refuses a module that is not a core at all', () => {
    expect(() => createCore({ exports: {} })).toThrow(/no exported memory/);
    expect(() => createCore({ exports: { memory: new WebAssembly.Memory({ initial: 1 }) } })).toThrow(
      /core_abi_version/,
    );
  });

  it('refuses a core built against a different ABI', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    expect(() =>
      createCore({ exports: { memory, core_abi_version: () => 99 } }),
    ).toThrow(/ABI version 99, expected 1/);
  });
});

describe('buffers', () => {
  it('allocates, tracks a length, and reads back what was written', () => {
    const buffer = core.createBuffer(1024);
    expect(buffer.capacity).toBe(1024);

    const input = sine(440, 512);
    core.writeBuffer(buffer, input);

    expect(core.trackedLength(buffer)).toBe(512);
    expect(core.readBuffer(buffer)).toEqual(input);

    core.destroyBuffer(buffer);
  });

  it('allocates zeroed, so a fresh buffer reads silence rather than memory', () => {
    const buffer = core.createBuffer(16);
    const out = core.readBuffer(buffer);
    expect(out.length).toBe(0);
    expect(Array.from(core.samples(buffer, 16)).every((v) => v === 0)).toBe(true);
    core.destroyBuffer(buffer);
  });

  it('refuses a capacity of zero or a non-integer', () => {
    expect(() => core.createBuffer(0)).toThrow(TypeError);
    expect(() => core.createBuffer(-1)).toThrow(TypeError);
    expect(() => core.createBuffer(1.5)).toThrow(TypeError);
    expect(() => core.createBuffer('1024')).toThrow(TypeError);
  });

  it('refuses to write more samples than the buffer holds', () => {
    const buffer = core.createBuffer(16);
    expect(() => core.writeBuffer(buffer, new Float32Array(17))).toThrow(RangeError);
    // The length must not have moved, or a refused write would still change the measurement.
    expect(core.trackedLength(buffer)).toBe(0);
    core.destroyBuffer(buffer);
  });

  it('refuses to use a buffer twice destroyed', () => {
    const buffer = core.createBuffer(8);
    core.destroyBuffer(buffer);
    expect(() => core.writeBuffer(buffer, new Float32Array(1))).toThrow(TypeError);
    expect(() => core.destroyBuffer(buffer)).toThrow(TypeError);
  });

  it('survives out-parameter writes, which land in scratch between the allocations', () => {
    // An out-parameter write must touch no buffer's header. A scratch allocation that did not
    // cover its own header returned an address inside whatever the allocator placed next, so
    // the write landed on a neighbouring buffer's header fields instead of on scratch.
    //
    // Repeated over many buffers rather than three, because which allocation gets hit depends
    // on the allocator, and a check that only fails for one unlucky layout is not a check.
    for (let round = 0; round < 4; round += 1) {
      const buffers = [];
      for (let i = 0; i < 8; i += 1) {
        const buffer = core.createBuffer(64);
        core.writeBuffer(buffer, sine(440 + i, 32));
        buffers.push(buffer);
      }
      // Interleave out-parameter writes with assertions, so corruption shows up where it lands.
      buffers.forEach((buffer, i) => {
        expect(core.trackedLength(buffer)).toBe(32);
        expect(core.trackedCapacity(buffer)).toBe(64);
        expect(core.goertzelPower(buffer, 440 + i, RATE)).toBeGreaterThan(0);
        expect(core.trackedLength(buffer)).toBe(32);
        expect(core.trackedCapacity(buffer)).toBe(64);
      });
      for (const buffer of buffers) {
        expect(core.readBuffer(buffer).length).toBe(32);
        expect(() => core.destroyBuffer(buffer)).not.toThrow();
      }
    }
  });

  it('holds a buffer whose contents survive independently of the caller array', () => {
    const buffer = core.createBuffer(8);
    const input = Float32Array.from([1, 2, 3]);
    core.writeBuffer(buffer, input);
    input[0] = 99;
    expect(Array.from(core.readBuffer(buffer))).toEqual([1, 2, 3]);
    core.destroyBuffer(buffer);
  });
});

describe('Goertzel power', () => {
  it('matches an independently computed reference', () => {
    const buffer = core.createBuffer(4096);
    const input = sine(1000, 4096);
    core.writeBuffer(buffer, input);
    expect(core.goertzelPower(buffer, 1000, RATE)).toBeCloseTo(
      referenceGoertzel(input, 1000),
      3,
    );
    core.destroyBuffer(buffer);
  });

  it('finds the frequency that is there and not one that is not', () => {
    const buffer = core.createBuffer(4096);
    core.writeBuffer(buffer, sine(440, 4096));
    const at440 = core.goertzelPower(buffer, 440, RATE);
    const at1000 = core.goertzelPower(buffer, 1000, RATE);
    expect(at440).toBeGreaterThan(0);
    expect(at440).toBeGreaterThan(at1000 * 100);
    core.destroyBuffer(buffer);
  });

  it('reports a zero length as an error rather than returning zero power', () => {
    const buffer = core.createBuffer(64);
    expect(() => core.goertzelPower(buffer, 440, RATE)).toThrow(/CoreLengthError/);
    core.destroyBuffer(buffer);
  });

  it('refuses a frequency outside the sample rate', () => {
    const buffer = core.createBuffer(64);
    core.writeBuffer(buffer, sine(440, 64));
    expect(() => core.goertzelPower(buffer, 0, RATE)).toThrow(/CoreRangeError/);
    expect(() => core.goertzelPower(buffer, -1, RATE)).toThrow(/CoreRangeError/);
    expect(() => core.goertzelPower(buffer, 440, 0)).toThrow(/CoreRangeError/);
    expect(() => core.goertzelPower(buffer, RATE, RATE)).toThrow(/CoreRangeError/);
    expect(() => core.goertzelPower(buffer, RATE * 2, RATE)).toThrow(/CoreRangeError/);
    core.destroyBuffer(buffer);
  });

  it('refuses a NaN or infinite frequency', () => {
    const buffer = core.createBuffer(64);
    core.writeBuffer(buffer, sine(440, 64));
    expect(() => core.goertzelPower(buffer, Number.NaN, RATE)).toThrow(/CoreRangeError/);
    expect(() => core.goertzelPower(buffer, Number.POSITIVE_INFINITY, RATE)).toThrow(/CoreRangeError/);
    core.destroyBuffer(buffer);
  });
});