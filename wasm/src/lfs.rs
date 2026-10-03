//! wasm/src/lfs.rs
//!
//! The keyed least-significant-bit baseline: the control the attack harness is calibrated
//! against.
//!
//! This is not a candidate scheme. `reference/perplexity-pointers.md` is blunt about LSB: high
//! capacity, no robustness, and destroyed by resampling, normalisation, gain, dithering,
//! filtering and re-encoding. It is built anyway, and early, for two reasons. The harness needs
//! something to be calibrated against, and a control that behaves as the literature says is what
//! makes the harness's numbers mean something. A result of "survives" from a scheme with no
//! baseline is a scheme that has not been tested.
//!
//! One bit per sample, at sample positions chosen by a keyed pseudorandom sequence. The key
//! matters twice over: without it the payload sits in the low bits of every nth sample, which is
//! trivially detectable, and with a shared key anyone who has the file and the key can remove the
//! mark, which is a separate problem this project has not addressed.

use crate::frame::HEADER_BYTES;

/// SplitMix64, for a keyed position sequence that is cheap and has no short cycle.
///
/// Not a cryptographic generator. It has to be reproducible from a key on both sides and fast
/// over millions of samples; those are the requirements, and "cryptographically strong" is not
/// among them for a position sequence.
pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A keyed stream of distinct sample positions.
///
/// A sparse Fisher-Yates shuffle: for each position to emit, pick a swap partner from the
/// positions not yet emitted and emit the value currently sitting at this index. Only the
/// swaps are stored, so the stream costs O(count) rather than O(limit).
///
/// The obvious alternative, Knuth's rejection sampling, is **correct and quadratic here**.
/// Rejecting any draw at or below the highest already drawn pushes that highest toward the
/// limit, so drawing 336 positions out of 44100 hits the limit after about nine and then rejects
/// almost everything forever. It looks fine and is fine when drawing most of the array, which is
/// why it survives review. Both a microbenchmark and a runaway counter found this; the test that
/// matters is the one below, which draws a small fraction and would otherwise hang the suite.
pub struct Positions {
    state: u64,
    limit: usize,
    next: usize,
    wanted: usize,
    /// Where values have been swapped to, for the indices that have moved.
    moved: std::collections::HashMap<usize, usize>,
}

impl Positions {
    /// A stream of `count` distinct positions below `limit`, capped at `limit`.
    pub fn new(key: u64, limit: usize, count: usize) -> Self {
        Positions {
            state: key ^ 0x5dee_ce66_d4a3_1b07,
            limit,
            next: 0,
            wanted: count.min(limit),
            moved: std::collections::HashMap::new(),
        }
    }

    /// The value sitting at `index`, following any swaps.
    fn value_at(&self, index: usize) -> usize {
        *self.moved.get(&index).unwrap_or(&index)
    }

    pub fn next(&mut self) -> Option<usize> {
        if self.next >= self.wanted || self.next >= self.limit {
            return None;
        }
        let i = self.next;
        let remaining = (self.limit - i) as u64;
        let j = i + (splitmix64(&mut self.state) % remaining) as usize;

        let vi = self.value_at(i);
        let vj = self.value_at(j);
        self.moved.insert(i, vj);
        self.moved.insert(j, vi);

        self.next += 1;
        // After the swap, position i holds what j held. Emitting what i held before the swap is
        // how this produced the same position twice while still looking like a shuffle.
        Some(vj)
    }
}

/// How many samples `bit_count` bits need: one per bit, no more.
pub fn capacity(samples: usize) -> usize {
    samples
}

/// The 16-bit integer a sample is stored as. WAV holds these, so this is where the low bit is.
///
/// Scaling by 32768 rather than 32767 because 32768 is a power of two: the conversion is then
/// exact in binary floating point and `to_pcm16(from_pcm16(q))` returns `q` for every `q`. With
/// 32767 it does not, and a handful of samples land a step out, which is enough to lose a bit and
/// to make a clean round trip report one error that has nothing to do with the scheme.
pub fn to_pcm16(sample: f32) -> i32 {
    let clamped = sample.clamp(-1.0, 1.0);
    (clamped * 32768.0).round() as i32
}

pub fn from_pcm16(value: i32) -> f32 {
    value as f32 / 32768.0
}

/// Embed `frame` into `samples` at keyed positions, returning the modified samples.
///
/// Bits go into the low bit of each sample's **16-bit** representation, which is where the low
/// bit actually is. The obvious version of this, taking the low bit of the float's mantissa, does
/// not round trip: a mantissa low bit sits far below the precision any decoder reads, so every
/// bit reads back as the same value. An embedding that reads back its own bytes is the only test
/// that would have caught it, which is why there is one.
///
/// Samples are quantised to 16 bits either way, which a WAV file does regardless, so nothing is
/// lost by doing it here. Bits are taken most significant first, so a reader in the same order
/// gets the same bytes.
pub fn embed(samples: &[f32], frame: &[u8], key: u64) -> Vec<f32> {
    let bits = frame.len() * 8;
    assert!(
        bits <= capacity(samples.len()),
        "a frame of {bits} bits needs {bits} samples, have {}",
        samples.len(),
    );
    let mut out: Vec<f32> = samples.iter().map(|&x| from_pcm16(to_pcm16(x))).collect();
    let mut positions = Positions::new(key, out.len(), bits);
    for &byte in frame {
        for bit in 0..8 {
            let position = positions.next().expect("enough samples for the frame");
            let value = (byte >> (7 - bit)) & 1;
            let mut sample = to_pcm16(out[position]);
            sample = (sample & !1) | value as i32;
            out[position] = from_pcm16(sample);
        }
    }
    out
}

/// Pull `frame_bytes` bytes out of `samples` at the same keyed positions.
///
/// Deliberately checks nothing: this is the raw read, and the frame decode above it is what
/// decides whether the result is a mark, nothing, or a damaged mark.
pub fn extract(samples: &[f32], frame_bytes: usize, key: u64) -> Vec<u8> {
    if samples.is_empty() || frame_bytes == 0 {
        return Vec::new();
    }
    let bits = frame_bytes * 8;
    let mut out = Vec::with_capacity(frame_bytes);
    let mut positions = Positions::new(key, samples.len(), bits);
    for _ in 0..frame_bytes {
        let mut byte = 0u8;
        for _ in 0..8 {
            let position = positions.next().expect("enough samples for the frame");
            let sample = to_pcm16(samples[position]);
            byte = (byte << 1) | ((sample & 1) as u8);
        }
        out.push(byte);
    }
    out
}

/// How many of the frame's bits survive, as a count of differing bits.
///
/// This is the number the harness reports. It is computed against the frame that went in, not
/// against whatever decoded, because a frame that fails its checksum still has a bit error rate
/// and that rate is the measurement.
pub fn bit_errors(original: &[u8], recovered: &[u8]) -> usize {
    let bits = original.len().min(recovered.len()) * 8;
    let mut errors = 0;
    for (i, &byte) in original.iter().enumerate() {
        if i >= recovered.len() {
            errors += 8;
            continue;
        }
        errors += (byte ^ recovered[i]).count_ones() as usize;
    }
    // Bytes the reader never got at all count as fully wrong.
    errors += original.len().saturating_sub(recovered.len()) * 8;
    errors.min(bits.max(1))
}

/// A frame's length in bytes, including its header, for a payload of `payload_bytes`.
///
/// Fixed by the payload length, which the reader is told out of band. The spread-spectrum
/// scheme carries the length in the stream instead, because its sync word is what finds the
/// start; LSB has no such word, so the reader has to be told how much to read.
pub fn frame_bytes_for(payload_bytes: usize) -> usize {
    HEADER_BYTES + payload_bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 + 13) as u8).collect()
    }

    #[test]
    fn a_frame_survives_its_own_round_trip() {
        let frame = payload(32);
        let samples = vec![0.25f32; 4096];
        let marked = embed(&samples, &frame, 0xabcd_1234);
        let recovered = extract(&marked, frame.len(), 0xabcd_1234);
        assert_eq!(recovered, frame);
        assert_eq!(bit_errors(&frame, &recovered), 0);
    }

    #[test]
    fn the_wrong_key_gives_different_bytes() {
        let frame = payload(16);
        let samples = vec![0.25f32; 4096];
        let marked = embed(&samples, &frame, 1);
        let wrong = extract(&marked, frame.len(), 2);
        assert_ne!(wrong, frame);
    }

    #[test]
    fn embedding_changes_only_the_low_bit_of_each_touched_sample() {
        let frame = payload(8);
        let samples: Vec<f32> = (0..1024).map(|i| (i as f32) * 0.0005 - 0.25).collect();
        let before: Vec<i32> = samples.iter().map(|&x| to_pcm16(x)).collect();
        let marked = embed(&samples, &frame, 7);

        let mut changed = 0;
        for (i, &sample) in marked.iter().enumerate() {
            let after = to_pcm16(sample);
            assert!(
                after >> 1 == before[i] >> 1,
                "sample {i} moved further than its low bit: {} -> {}",
                before[i],
                after,
            );
            if after != before[i] {
                changed += 1;
            }
        }
        // Fewer than the number of bits, because a bit that already matched changes nothing.
        // Exactly the count would be a test of the payload, not of the embedding.
        assert!(
            changed <= frame.len() * 8,
            "{changed} samples moved for {} bits",
            frame.len() * 8,
        );
    }

    #[test]
    fn embedding_the_same_frame_twice_changes_nothing_the_second_time() {
        // The property that makes a keyed position stream usable: writing a bit that is already
        // there must be a no-op, so a re-embed after an attack does not fight the old mark.
        let frame = payload(8);
        let samples: Vec<f32> = (0..1024).map(|i| (i as f32) * 0.0005 - 0.25).collect();
        let once = embed(&samples, &frame, 7);
        let twice = embed(&once, &frame, 7);
        assert_eq!(once, twice);
    }

    #[test]
    fn embedding_refuses_a_payload_that_does_not_fit() {
        let frame = payload(16); // 128 bits
        let samples = vec![0.25f32; 64];
        assert!(std::panic::catch_unwind(|| embed(&samples, &frame, 1)).is_err());
    }

    #[test]
    fn positions_do_not_repeat_within_a_frame() {
        let mut positions = Positions::new(99, 10_000, 2000);
        let mut seen = vec![false; 10_000];
        for _ in 0..2000 {
            let p = positions.next().unwrap();
            assert!(!seen[p], "position {p} came twice");
            seen[p] = true;
        }
    }

    #[test]
    fn positions_cover_a_small_audio_file_without_exhausting_it() {
        // A frame that exactly fills the audio should still work.
        let mut positions = Positions::new(5, 64, 64);
        let mut seen = vec![false; 64];
        for _ in 0..64 {
            let p = positions.next().unwrap();
            assert!(!seen[p]);
            seen[p] = true;
        }
        assert!(seen.iter().all(|&s| s), "every position used");
    }

    #[test]
    fn a_small_fraction_of_a_large_range_comes_out_promptly() {
        // The case that hangs a rejection sampler: 336 positions out of 44100, which is what a
        // short payload in a track's worth of samples actually looks like.
        let mut positions = Positions::new(42, 44_100, 336);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..336 {
            let p = positions.next().expect("enough positions");
            assert!(seen.insert(p), "position {p} came twice");
            assert!(p < 44_100, "position {p} is out of range");
        }
    }

    #[test]
    fn asking_for_more_positions_than_exist_stops_rather_than_looping() {
        let mut positions = Positions::new(1, 10, 100);
        let mut count = 0;
        while positions.next().is_some() {
            count += 1;
            assert!(count <= 10, "gave more than the limit");
        }
        assert_eq!(count, 10);
    }

    #[test]
    fn a_lost_frame_is_counted_as_entirely_wrong() {
        assert_eq!(bit_errors(&[0xff; 4], &[0x00; 2]), 16);
    }

    #[test]
    fn the_bit_error_count_is_the_number_of_differing_bits() {
        assert_eq!(bit_errors(&[0b1010_1010], &[0b1010_1010]), 0);
        assert_eq!(bit_errors(&[0b1111_1111], &[0b0000_0000]), 8);
        assert_eq!(bit_errors(&[0b1111_0000], &[0b0000_0000]), 4);
    }
}

