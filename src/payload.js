// src/payload.js
//
// The text layer: turning a payload into bytes and back, with the checksum.
//
// This is here rather than in Rust because it is a text concern and the platform already does
// the hard part. Punycode is `URL`'s job in both hosts, so there is no hand-rolled encoder to
// get wrong, which is the reason this side of the codec stayed out of the core.
//
// The checksum is a plain byte sum modulo 128, which is what `reference/WebBeep`'s
// `Checksum` does. It catches a wrong length and it does not catch a transposition, since a sum
// does not depend on order. That is a property of the reference and is ported as-is; the
// stronger checksum the real project wants is a TODO, not something to smuggle in here.

/** Highest value the tone table can carry: a high nibble of 7 is the limit, so 0..127. */
export const MAX_PAYLOAD_BYTES = 128;

/**
 * A checksum character for `bytes`, as `Checksum.makeChecksumString` computes it.
 *
 * The reference sums Java `byte` values, which are signed, so a byte above 127 contributes
 * negatively. Only 0..127 is encodable anyway, so this only ever sees positive values, and the
 * signedness is noted rather than reproduced.
 */
export function checksumByte(bytes) {
  let sum = 0;
  for (const byte of bytes) {
    sum += byte;
  }
  return sum % 128;
}

/** UTF-8 bytes of `text`. */
export function toBytes(text) {
  return new TextEncoder().encode(text);
}

/**
 * The payload as bytes: checksum character first, then the text.
 *
 * `domainToASCII` is not available in every browser, so punycode is applied through `URL`,
 * which does the same thing and is on both sides.
 */
export function encodePayload(text, { punycode = true } = {}) {
  const prepared = punycode ? toAscii(text) : text;
  const bytes = toBytes(prepared);
  if (bytes.length === 0) {
    // The core refuses a zero-length payload, and so does this: an empty payload is a mistake,
    // not something to encode into silence.
    throw new RangeError('payload is empty');
  }
  if (bytes.length + 1 > MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `payload is ${bytes.length} bytes, and with its checksum the table carries at most ${MAX_PAYLOAD_BYTES - 1}`,
    );
  }
  const out = new Uint8Array(bytes.length + 1);
  out[0] = checksumByte(bytes);
  out.set(bytes, 1);
  return out;
}

/**
 * Bytes back to text, verifying the checksum.
 *
 * Returns null when the checksum fails rather than returning the text anyway. The reference's
 * `Checksum.checksum` logs "Checksum failed!" and returns the string regardless, with its throw
 * commented out, so a misread payload is reported as a payload. This is the one place the port
 * deliberately does not match, because a false payload is the failure that matters most in a
 * watermark: the caller can act on a wrong answer. See MISTAKES.md.
 */
export function decodePayload(bytes, { punycode = true } = {}) {
  if (bytes.length === 0) {
    return { ok: false, reason: 'no-mark', text: '' };
  }
  if (bytes.length < 2) {
    return { ok: false, reason: 'too-short', text: '' };
  }
  const body = bytes.subarray(1);
  const expected = bytes[0];
  if (checksumByte(body) !== expected) {
    return { ok: false, reason: 'checksum', text: '' };
  }
  const text = new TextDecoder().decode(body);
  return { ok: true, reason: 'ok', text: punycode ? fromAscii(text) : text };
}

/**
 * Punycode a payload, when it looks like a hostname or URL.
 *
 * Only attempted for something with a scheme or a dot, because punycoding arbitrary text is not
 * what the reference's `IDN.toASCII` did with a payload either: it applied it to the whole
 * string and the result is the same for ASCII.
 */
export function toAscii(text) {
  try {
    if (/^[a-z]+:\/\//i.test(text)) {
      return new URL(text).href;
    }
  } catch {
    // Not a URL after all. Fall through and use the text as it stands.
  }
  return text;
}

/** Undo `toAscii`, where the result is still punycode. */
export function fromAscii(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}