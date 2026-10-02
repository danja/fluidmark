//! wasm/src/pitch.rs
//!
//! The pitch finder, ported from `reference/WebBeep`'s `pitchfinders/GoertzelPitchFinder.java`.
//!
//! The reference collects its findings into a `HashSet<Double>`, and that detail is load
//! bearing. Its tone table repeats several frequencies: 523.25, 587.33, 659.26, 783.99, 880
//! and 1567.98 each appear twice, distinguished only by duration. Iterating all 24 entries and
//! reporting each one above the threshold therefore reports the same frequency twice, and the
//! character decoder infers a tone's duration from how many pitches it found: two means both
//! ran long, none means both ran short, one means they differ. Counting 24 indices instead of
//! distinct frequencies makes that count never match, and every character decodes to garbage.
//!
//! So this returns distinct frequencies, in table order. Table order rather than hash order is
//! a deliberate difference: the reference's iteration order of a `HashSet<Double>` is not
//! specified, and `CharacterDecoder` takes the first two elements of it as the low and high
//! notes and then sorts by value. Sorting by frequency gives the same answer without depending
//! on an unspecified order.

use crate::dsp::goertzel_power;
use crate::tables::{self, GOERTZEL_THRESHOLD};

/// The frequencies found in one chunk of samples, distinct and in table order.
pub type Detected = Vec<f64>;

/// Frequencies whose Goertzel power exceeds `threshold`, deduplicated by value.
///
/// Returns frequencies rather than table indices, which is what the reference's set of
/// frequencies amounts to. Where a frequency appears twice in the table, the first occurrence
/// wins, because the two differ only in duration and the caller has a duration to match
/// against.
pub fn find_pitches(samples: &[f32], sample_rate: f64, threshold: f64) -> Detected {
    let mut found: Detected = Vec::new();
    for freq in tables::all_freqs() {
        if !found.contains(&freq) && goertzel_power(samples, freq, sample_rate) > threshold {
            found.push(freq);
        }
    }
    found
}

/// The reference's default finder, with its own default threshold.
pub fn find_pitches_default(samples: &[f32]) -> Detected {
    find_pitches(samples, tables::SAMPLE_RATE as f64, GOERTZEL_THRESHOLD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tables::SAMPLE_RATE;

    /// A dual tone as `WaveMaker` builds it: two sines summed, over `len` samples.
    fn dual(low: f64, high: f64, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let t = i as f64 / SAMPLE_RATE as f64;
                (tables::AMPLITUDE * (2.0 * std::f64::consts::PI * low * t).sin()
                    + tables::AMPLITUDE * (2.0 * std::f64::consts::PI * high * t).sin())
                    as f32
            })
            .collect()
    }

    #[test]
    fn finds_both_tones_of_a_dual_tone() {
        let samples = dual(tables::LOW_FREQ[0], tables::HIGH_FREQ[1], 679);
        let found = find_pitches_default(&samples);
        assert!(
            found.contains(&tables::LOW_FREQ[0]),
            "should find low tone 0, got {found:?}",
        );
        assert!(
            found.contains(&tables::HIGH_FREQ[1]),
            "should find high tone 1, got {found:?}",
        );
    }

    #[test]
    fn a_repeated_frequency_is_reported_once() {
        // 587.33 is at HIGH_FREQ[1] and HIGH_FREQ[6]. Both have the same Goertzel power, so an
        // implementation that reports table indices reports it twice and the character decoder
        // reads the wrong number of pitches. This is the test for that.
        assert_eq!(tables::HIGH_FREQ[1], tables::HIGH_FREQ[6], "the fixture needs the duplicate");
        let samples = dual(tables::LOW_FREQ[0], tables::HIGH_FREQ[1], 679);
        let found = find_pitches_default(&samples);
        let occurrences = found.iter().filter(|&&f| f == 587.33).count();
        assert_eq!(occurrences, 1, "587.33 should be reported once, got {found:?}");
    }

    #[test]
    fn reports_nothing_for_silence() {
        let samples = vec![0.0f32; 679];
        assert!(find_pitches_default(&samples).is_empty());
    }

    #[test]
    fn reports_nothing_for_an_empty_chunk() {
        assert!(find_pitches_default(&[]).is_empty());
    }

    #[test]
    fn a_threshold_nobody_can_reach_reports_nothing() {
        let samples = dual(tables::LOW_FREQ[0], tables::HIGH_FREQ[0], 679);
        assert!(find_pitches(&samples, SAMPLE_RATE as f64, f64::MAX).is_empty());
    }

    #[test]
    fn a_threshold_of_zero_reports_every_distinct_frequency() {
        let samples = dual(tables::LOW_FREQ[0], tables::HIGH_FREQ[0], 679);
        let found = find_pitches(&samples, SAMPLE_RATE as f64, 0.0);
        let all = tables::all_freqs();
        let mut unique: Vec<f64> = Vec::new();
        for freq in &all {
            if !unique.contains(freq) {
                unique.push(*freq);
            }
        }
        assert_eq!(unique.len(), 15, "the 24-entry table holds 15 distinct frequencies");
        assert_eq!(found.len(), unique.len(), "got {found:?}");
    }
}