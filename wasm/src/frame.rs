//! wasm/src/frame.rs
//!
//! The payload framing: what goes into the mark and how a reader tells a mark from nothing.
//!
//! This is the part that decides whether the system is safe. A reader handed unmarked audio must
//! be able to say "there is no mark here" rather than reporting whatever bytes it managed to
//! pull out, because the difference is a false positive and a false positive on a watermark means
//! claiming a track carries an IRI it does not. So the frame leads with a magic number, a
//! version, a length and a checksum, and a reader that does not find them says so.
//!
//! The payload inside is opaque bytes. The brief's payload is layered, a header declaring a mark,
//! then metadata, then an identifying IRI, then arbitrary text, and the layering of *that* is
//! still an open decision, so it is not decided here. What is here is the envelope it will sit
//! in.
//!
//! `docs/steganography.md` requires the reader to distinguish "the mark was found and the
//! payload checksummed" from "something was found". `decode` returns that as its error type.

/// The first four bytes of every frame. Spells FLMK.
pub const MAGIC: [u8; 4] = *b"FLMK";

/// Framing version. Bump when the layout changes; a reader refuses a version it does not know.
pub const VERSION: u8 = 1;

/// magic, version, flags, length, crc.
pub const HEADER_BYTES: usize = 10;

/// Flags. None defined yet.
pub const FLAG_NONE: u8 = 0;

/// Why a frame did not decode. The distinction between `NoMark` and `Damaged` is the whole point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Not enough bytes to hold even a header.
    TooShort,
    /// The magic does not match: there is no mark here.
    NoMark,
    /// The magic matches, so a mark is probably present, but the version is one we do not know.
    UnknownVersion(u8),
    /// The magic and version match but the payload is the wrong length for the header.
    BadLength,
    /// The checksum does not match: a mark is present and damaged.
    BadChecksum,
}

/// A framed payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub version: u8,
    pub flags: u8,
    pub payload: Vec<u8>,
}

/// CRC-16/CCITT-FALSE, the usual framing checksum. Two bytes, no table.
///
/// Chosen over the reference's byte sum, which cannot detect a transposition, and over a
/// cryptographic hash, which is more than a framing layer should pay for. Whether the payload
/// needs error correction on top is a separate question, answered in
/// `docs/steganography.md`.
pub fn crc16(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0xffff;
    for &byte in bytes {
        crc ^= (byte as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// Wrap a payload in a frame.
pub fn encode(payload: &[u8], flags: u8) -> Vec<u8> {
    let length = payload.len();
    assert!(length <= u16::MAX as usize, "payload of {length} bytes does not fit a length field");
    let crc = crc16(payload);

    let mut out = Vec::with_capacity(HEADER_BYTES + length);
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(flags);
    out.extend_from_slice(&(length as u16).to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Read a frame, saying why not.
///
/// `None` is never returned: a failure is a reason, because "no mark" and "damaged mark" lead to
/// different answers and the caller has to be able to give both.
pub fn decode(bytes: &[u8]) -> Result<Frame, FrameError> {
    if bytes.len() < HEADER_BYTES {
        return Err(FrameError::TooShort);
    }
    if bytes[0..4] != MAGIC {
        return Err(FrameError::NoMark);
    }
    let version = bytes[4];
    if version != VERSION {
        return Err(FrameError::UnknownVersion(version));
    }
    let flags = bytes[5];
    let length = u16::from_le_bytes([bytes[6], bytes[7]]) as usize;
    let crc = u16::from_le_bytes([bytes[8], bytes[9]]);

    if bytes.len() < HEADER_BYTES + length {
        return Err(FrameError::BadLength);
    }
    let payload = bytes[HEADER_BYTES..HEADER_BYTES + length].to_vec();
    if crc16(&payload) != crc {
        return Err(FrameError::BadChecksum);
    }
    Ok(Frame { version, flags, payload })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips() {
        let payload = b"http://danbri.org/foaf";
        let decoded = decode(&encode(payload, FLAG_NONE)).expect("should decode");
        assert_eq!(decoded.payload, payload.to_vec());
        assert_eq!(decoded.version, VERSION);
        assert_eq!(decoded.flags, FLAG_NONE);
    }

    #[test]
    fn an_empty_payload_round_trips() {
        // A frame with no payload is still a mark, which is a legitimate thing to find.
        assert_eq!(decode(&encode(b"", FLAG_NONE)).unwrap().payload, Vec::<u8>::new());
    }

    #[test]
    fn nothing_is_reported_as_no_mark_rather_than_as_a_payload() {
        // The important one. Noise, music, silence: none of it is a mark.
        assert_eq!(decode(b""), Err(FrameError::TooShort));
        assert_eq!(decode(b"abcd"), Err(FrameError::TooShort));
        assert_eq!(decode(&[0u8; 64]), Err(FrameError::NoMark));
        assert_eq!(decode(b"not a frame at all, really"), Err(FrameError::NoMark));
    }

    #[test]
    fn a_damaged_payload_is_reported_as_damaged_and_not_as_no_mark() {
        let mut bytes = encode(b"payload", FLAG_NONE);
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert_eq!(decode(&bytes), Err(FrameError::BadChecksum));
    }

    #[test]
    fn a_damaged_header_length_is_reported_separately_from_a_damaged_payload() {
        let mut bytes = encode(b"payload", FLAG_NONE);
        bytes[6..8].copy_from_slice(&999u16.to_le_bytes());
        assert_eq!(decode(&bytes), Err(FrameError::BadLength));
    }

    #[test]
    fn an_unknown_version_is_its_own_answer() {
        let mut bytes = encode(b"payload", FLAG_NONE);
        bytes[4] = 99;
        assert_eq!(decode(&bytes), Err(FrameError::UnknownVersion(99)));
    }

    #[test]
    fn the_checksum_detects_a_transposition_which_a_byte_sum_could_not() {
        // The reference sums bytes, so "ab" and "ba" checksum the same. This one does not.
        assert_ne!(crc16(b"ab"), crc16(b"ba"));
    }

    #[test]
    fn the_checksum_detects_a_single_bit_change() {
        let base = crc16(b"the quick brown fox");
        let mut flipped = b"the quick brown fox".to_vec();
        flipped[4] ^= 0x01;
        assert_ne!(base, crc16(&flipped));
    }

    #[test]
    fn flags_survive_the_round_trip() {
        assert_eq!(decode(&encode(b"x", 0b1010)).unwrap().flags, 0b1010);
    }
}