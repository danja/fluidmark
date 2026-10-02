// src/frame.js
//
// The payload frame, in JavaScript, mirroring `wasm/src/frame.rs` byte for byte.
//
// Duplicated rather than shared because the frame is 10 bytes of layout and a CRC over a few
// dozen bytes, neither of which is worth a boundary call, and because a reader that has to ask
// the core whether a frame is any good cannot be used on bytes that came from somewhere else.
// The test in tests/watermark.test.js checks the two agree, which is what stops the duplication
// being a fork.

/** What a read found. The cases must stay distinguishable. */
export const REASONS = {
  OK: 'ok',
  NO_MARK: 'no-mark',
  DAMAGED: 'damaged',
};

export const MAGIC = [0x46, 0x4c, 0x4d, 0x4b]; // "FLMK"
export const VERSION = 1;
export const HEADER_BYTES = 10;

/** CRC-16/CCITT-FALSE, the same one the core uses. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= (byte << 8) & 0xffff;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** Wrap a payload: magic, version, flags, length, CRC-16, then the payload. */
export function frame(payload, flags = 0) {
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError('frame needs a Uint8Array payload');
  }
  if (payload.length > 0xffff) {
    throw new RangeError(`payload of ${payload.length} bytes does not fit a 16-bit length`);
  }
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = flags;
  out[6] = payload.length & 0xff;
  out[7] = (payload.length >> 8) & 0xff;
  const crc = crc16(payload);
  out[8] = crc & 0xff;
  out[9] = (crc >> 8) & 0xff;
  out.set(payload, HEADER_BYTES);
  return out;
}

/** Read a frame, or say why not. */
export function unframe(bytes) {
  if (bytes.length < HEADER_BYTES) {
    return { ok: false, reason: REASONS.NO_MARK };
  }
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== MAGIC[i]) {
      return { ok: false, reason: REASONS.NO_MARK };
    }
  }
  if (bytes[4] !== VERSION) {
    return { ok: false, reason: REASONS.DAMAGED, detail: `version ${bytes[4]}` };
  }
  const length = bytes[6] | (bytes[7] << 8);
  if (bytes.length < HEADER_BYTES + length) {
    return { ok: false, reason: REASONS.DAMAGED, detail: 'payload shorter than its length field' };
  }
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + length);
  const expected = bytes[8] | (bytes[9] << 8);
  if (crc16(payload) !== expected) {
    return { ok: false, reason: REASONS.DAMAGED, detail: 'checksum' };
  }
  return { ok: true, reason: REASONS.OK, payload, flags: bytes[5] };
}

/** Frame bytes, header included, for a payload of this many bytes. */
export function frameBytesFor(payloadBytes) {
  return HEADER_BYTES + payloadBytes;
}

/** Bits differing between two frames, which is the number the harness reports. */
export function bitErrors(expected, recovered) {
  let errors = 0;
  const shared = Math.min(expected.length, recovered.length);
  for (let i = 0; i < shared; i += 1) {
    let difference = expected[i] ^ recovered[i];
    while (difference) {
      errors += difference & 1;
      difference >>= 1;
    }
  }
  errors += (expected.length - shared) * 8;
  return errors;
}