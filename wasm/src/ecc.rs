//! wasm/src/ecc.rs
//!
//! Forward error correction and interleaving for the spread-spectrum stream.
//!
//! A rate-1/2 convolutional code, constraint length 7 (generators 171 and 133 octal, the one
//! deep-space links and 802.11 use), decoded by the Viterbi algorithm from soft values. The reader
//! has a soft value for every channel bit, a measure of how strongly the bit was read, and a soft
//! decoder uses that where a hard-decision one throws it away. It replaced Hamming(7,4), which
//! corrects one wrong bit in seven and has no memory of what came before: the convolutional code
//! spreads every bit over the next six, so a short burst of weak bits is corrected from its
//! neighbours. It costs more channel bits per byte, 16 against 14 plus a six-bit tail, and that is
//! what the extra margin is bought with.
//!
//! Every message is followed by six zero bits so the encoder ends in the zero state, and the decoder
//! starts and ends there. The CRC in the frame is what decides whether the result is believed.
//!
//! Interleaving is a keyed permutation, so a burst of damage in time lands on bits that are far
//! apart in the code rather than on one stretch of it.

use crate::lfs::Positions;

const CONSTRAINT: usize = 7;
const STATES: usize = 1 << (CONSTRAINT - 1);
const TAIL_BITS: usize = CONSTRAINT - 1;
const GEN_A: u32 = 0o171;
const GEN_B: u32 = 0o133;

/// Channel bits for a message of `bytes` bytes: two per message bit, and the tail.
pub const fn coded_bits(bytes: usize) -> usize {
    2 * (8 * bytes + TAIL_BITS)
}

/// The two output bits for input `bit` leaving `state`, and the state it leads to.
///
/// The register is the new bit above the six before it, most recent highest. The next state drops
/// the oldest.
#[inline]
fn step(state: usize, bit: u32) -> (u8, u8, usize) {
    let reg = (bit << 6) | state as u32;
    let a = (reg & GEN_A).count_ones() as u8 & 1;
    let b = (reg & GEN_B).count_ones() as u8 & 1;
    (a, b, (reg >> 1) as usize)
}

/// Bytes to coded bits, as 0 and 1, most significant bit first, with the tail.
pub fn encode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(coded_bits(bytes.len()));
    let mut state = 0usize;
    let message = bytes.iter().flat_map(|&byte| (0..8).rev().map(move |i| ((byte >> i) & 1) as u32));
    for bit in message.chain(std::iter::repeat(0).take(TAIL_BITS)) {
        let (a, b, next) = step(state, bit);
        out.push(a);
        out.push(b);
        state = next;
    }
    out
}

/// Soft values to `bytes` bytes. A positive value votes for a 1, a negative one for a 0, and its
/// size is how much the reader believed it. `soft` must hold exactly `coded_bits(bytes)` values,
/// and anything else is refused with `None` rather than decoded from a guess at where it ends.
pub fn decode(soft: &[f32], bytes: usize) -> Option<Vec<u8>> {
    if soft.len() != coded_bits(bytes) {
        return None;
    }
    let steps = soft.len() / 2;
    // For each step and state, which of the two possible predecessors survived. One bit, kept as a
    // byte for simplicity: the trellis for the longest message a read will ever reach is small.
    let mut survivor = vec![0u8; steps * STATES];
    let mut metric = [f32::NEG_INFINITY; STATES];
    metric[0] = 0.0;

    for t in 0..steps {
        let (s0, s1) = (soft[2 * t], soft[2 * t + 1]);
        let mut next = [f32::NEG_INFINITY; STATES];
        for state in 0..STATES {
            let m = metric[state];
            if m == f32::NEG_INFINITY {
                continue;
            }
            for bit in 0..2u32 {
                let (a, b, to) = step(state, bit);
                let branch = if a == 1 { s0 } else { -s0 } + if b == 1 { s1 } else { -s1 };
                let candidate = m + branch;
                if candidate > next[to] {
                    next[to] = candidate;
                    // `to` holds the new bit at its top, and the bit that fell off the bottom is
                    // all that is needed to say which predecessor this was.
                    survivor[t * STATES + to] = (state & 1) as u8;
                }
            }
        }
        metric = next;
    }

    // The tail brought the encoder to state zero, so the path ends there.
    let mut state = 0usize;
    let mut bits = vec![0u8; steps];
    for t in (0..steps).rev() {
        bits[t] = (state >> (CONSTRAINT - 2)) as u8 & 1;
        let dropped = survivor[t * STATES + state] as usize;
        state = ((state & (STATES / 2 - 1)) << 1) | dropped;
    }
    let message = &bits[..8 * bytes];
    Some(
        message
            .chunks_exact(8)
            .map(|byte| byte.iter().fold(0u8, |acc, &bit| (acc << 1) | bit))
            .collect(),
    )
}

/// The keyed permutation `interleave` and `deinterleave` share: coded bit `i` travels in channel
/// slot `permutation[i]`.
fn permutation(n: usize, key: u64) -> Vec<usize> {
    let mut positions = Positions::new(key, n, n);
    (0..n).map(|_| positions.next().expect("a permutation of n has n entries")).collect()
}

/// Put coded bits into channel order.
pub fn interleave<T: Copy + Default>(coded: &[T], key: u64) -> Vec<T> {
    let perm = permutation(coded.len(), key);
    let mut channel = vec![T::default(); coded.len()];
    for (i, &slot) in perm.iter().enumerate() {
        channel[slot] = coded[i];
    }
    channel
}

/// Put channel values back into coded order.
pub fn deinterleave<T: Copy + Default>(channel: &[T], key: u64) -> Vec<T> {
    let perm = permutation(channel.len(), key);
    perm.iter().map(|&slot| channel[slot]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn soft(bits: &[u8]) -> Vec<f32> {
        bits.iter().map(|&b| if b == 1 { 1.0 } else { -1.0 }).collect()
    }

    #[test]
    fn every_byte_round_trips() {
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(decode(&soft(&encode(&all)), 256), Some(all));
    }

    #[test]
    fn the_coded_length_is_what_the_arithmetic_says() {
        for bytes in [0, 1, 10, 32, 73] {
            assert_eq!(encode(&vec![0xa5; bytes]).len(), coded_bits(bytes));
        }
        assert_eq!(coded_bits(10), 172);
    }

    #[test]
    fn an_empty_message_is_just_its_tail() {
        assert_eq!(decode(&soft(&encode(&[])), 0), Some(Vec::new()));
    }

    #[test]
    fn scattered_wrong_bits_are_corrected() {
        let bytes = b"http://example.org/some/identifier".to_vec();
        let mut values = soft(&encode(&bytes));
        // One wrong bit in every twelve. Hamming(7,4) would take this as roughly one error in
        // every other codeword, and fail some.
        for v in values.iter_mut().step_by(12) {
            *v = -*v;
        }
        assert_eq!(decode(&values, bytes.len()), Some(bytes));
    }

    #[test]
    fn weak_wrong_values_lose_to_strong_right_ones() {
        let bytes = vec![0xa5, 0x3c, 0x0f, 0xf0];
        let mut values = soft(&encode(&bytes));
        // A third of the values wrong, but weakly, which is what a mark near the noise looks like.
        for (i, v) in values.iter_mut().enumerate() {
            if i % 3 == 0 {
                *v = -0.2 * *v;
            }
        }
        assert_eq!(decode(&values, bytes.len()), Some(bytes));
    }

    #[test]
    fn a_burst_after_interleaving_is_corrected() {
        let bytes: Vec<u8> = (0..40).collect();
        let coded = encode(&bytes);
        let mut channel = interleave(&soft(&coded), 5);
        // Twenty-four full-strength wrong values in a row, about 4% of the channel: far more than a
        // burst of weak ones that soft decoding tolerates, and still corrected once spread.
        for v in channel.iter_mut().skip(100).take(24) {
            *v = -*v;
        }
        assert_eq!(decode(&deinterleave(&channel, 5), bytes.len()), Some(bytes));
    }

    #[test]
    fn a_length_that_does_not_match_is_refused() {
        let values = soft(&encode(b"abc"));
        assert_eq!(decode(&values, 4), None);
        assert_eq!(decode(&values[..values.len() - 1], 3), None);
        assert_eq!(decode(&[], 1), None);
    }

    #[test]
    fn interleaving_is_a_permutation_and_undoes_itself() {
        let coded: Vec<u32> = (0..500).collect();
        let channel = interleave(&coded, 77);
        let mut sorted = channel.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, coded, "every value appears exactly once");
        assert_ne!(channel, coded);
        assert_eq!(deinterleave(&channel, 77), coded);
    }

    #[test]
    fn a_burst_in_the_channel_is_spread_across_the_code() {
        // 40 consecutive channel slots wiped out should land a few in each stretch of the code, not
        // forty in one.
        let n = 560;
        let wrong: Vec<bool> = {
            let mut channel = vec![false; n];
            channel.iter_mut().skip(100).take(40).for_each(|v| *v = true);
            deinterleave(&channel, 5)
        };
        let longest_run = wrong
            .split(|&w| !w)
            .map(|run| run.len())
            .max()
            .unwrap_or(0);
        assert!(longest_run <= 4, "{longest_run} wrong in a row after deinterleaving");
    }

    #[test]
    fn a_wrong_key_does_not_undo_the_interleave() {
        let coded: Vec<u32> = (0..100).collect();
        assert_ne!(deinterleave(&interleave(&coded, 1), 2), coded);
    }
}
