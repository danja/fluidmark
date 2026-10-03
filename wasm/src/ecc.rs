//! wasm/src/ecc.rs
//!
//! Forward error correction and interleaving for the spread-spectrum stream.
//!
//! Hamming(7,4), as the survey's 2024 phase-coding paper uses, decoded from soft values rather
//! than hard bits: for each seven-value group the decoder picks the codeword with the best
//! correlation, which corrects one error per group and does better than that when the damaged
//! value was a weak one. It is a modest code. Its job here is to turn the occasional wrong bit
//! after soft combining into a right one, and the CRC in the frame is what decides whether the
//! result is believed.
//!
//! Interleaving is a keyed permutation, so a burst of damage in time lands on bits that are far
//! apart in the code rather than on one codeword.

use crate::lfs::Positions;

/// Bits per coded byte: two nibbles, seven bits each.
pub const BITS_PER_BYTE: usize = 14;

fn codeword(nibble: u8) -> [u8; 7] {
    let d = [(nibble >> 3) & 1, (nibble >> 2) & 1, (nibble >> 1) & 1, nibble & 1];
    [
        d[0],
        d[1],
        d[2],
        d[3],
        d[0] ^ d[1] ^ d[3],
        d[0] ^ d[2] ^ d[3],
        d[1] ^ d[2] ^ d[3],
    ]
}

/// Bytes to coded bits, as 0 and 1, high nibble first.
pub fn encode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() * BITS_PER_BYTE);
    for &byte in bytes {
        out.extend_from_slice(&codeword(byte >> 4));
        out.extend_from_slice(&codeword(byte & 0x0f));
    }
    out
}

/// Soft values to bytes. A positive value votes for a 1, a negative one for a 0, and its size is
/// how much the reader believed it. `soft.len()` must be a multiple of 14; a trailing remainder
/// is ignored rather than guessed at.
pub fn decode(soft: &[f32]) -> Vec<u8> {
    let mut nibbles = Vec::with_capacity(soft.len() / 7);
    for group in soft.chunks_exact(7) {
        let mut best = (f32::NEG_INFINITY, 0u8);
        for nibble in 0..16u8 {
            let word = codeword(nibble);
            let score: f32 = word
                .iter()
                .zip(group)
                .map(|(&bit, &s)| if bit == 1 { s } else { -s })
                .sum();
            if score > best.0 {
                best = (score, nibble);
            }
        }
        nibbles.push(best.1);
    }
    nibbles.chunks_exact(2).map(|pair| (pair[0] << 4) | pair[1]).collect()
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
        assert_eq!(decode(&soft(&encode(&all))), all);
    }

    #[test]
    fn one_wrong_bit_in_every_group_is_corrected() {
        let bytes = b"http://example.org/".to_vec();
        let mut values = soft(&encode(&bytes));
        for group in values.chunks_exact_mut(7) {
            group[3] = -group[3];
        }
        assert_eq!(decode(&values), bytes);
    }

    #[test]
    fn a_weak_wrong_value_loses_to_two_strong_right_ones() {
        // Two errors in a group is beyond a hard-decision Hamming code. With soft values the
        // errors being weak is enough.
        let bytes = vec![0xa5];
        let mut values = soft(&encode(&bytes));
        values[0] = -0.1 * values[0];
        values[1] = -0.1 * values[1];
        assert_eq!(decode(&values), bytes);
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
    fn a_burst_in_the_channel_is_spread_across_codewords() {
        // Hamming(7,4) corrects one error per group, so it cannot survive a burst on its own: 40
        // wrong values in a row would ruin six groups outright. What interleaving buys is that the
        // same 40 land in many groups, a few each, which soft combining across repeats can then
        // repair. This measures the spread, not a correction the code does not make.
        let groups = 80;
        let wrong: Vec<bool> = {
            let mut channel = vec![false; groups * 7];
            channel.iter_mut().skip(100).take(40).for_each(|v| *v = true);
            deinterleave(&channel, 5)
        };
        let per_group: Vec<usize> = wrong.chunks(7).map(|g| g.iter().filter(|&&w| w).count()).collect();
        let hit = per_group.iter().filter(|&&n| n > 0).count();
        let worst = per_group.iter().copied().max().unwrap();
        assert!(hit >= 30, "only {hit} groups were touched");
        assert!(worst <= 4, "one group took {worst} of the burst");
    }

    #[test]
    fn a_wrong_key_does_not_undo_the_interleave() {
        let coded: Vec<u32> = (0..100).collect();
        assert_ne!(deinterleave(&interleave(&coded, 1), 2), coded);
    }
}
