//! wasm/src/signal.rs
//!
//! The processors the reference's pipeline is built from, ported one for one from
//! `reference/WebBeep`'s `processors/`. Each takes and returns samples.
//!
//! Every one of these is fragile in a way worth knowing, and all are ported as-is. The notes
//! say which.

/// Scale to a peak of +/- 1 and remove the zero offset, as `Normalise.normalise` does.
///
/// Divides by the peak-to-peak amplitude, so a buffer whose samples are all equal divides by
/// zero and yields infinity or NaN. The reference has the same division and no guard; a guard
/// here would change what the decoder sees, so it is not one.
pub fn normalise(input: &[f32]) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    let mut min = input[0] as f64;
    let mut max = input[0] as f64;
    for &x in &input[1..] {
        if (x as f64) < min {
            min = x as f64;
        }
        if (x as f64) > max {
            max = x as f64;
        }
    }
    let peak_amplitude = max - min;
    let offset = (max + min) / 2.0;
    let scale = 2.0 / peak_amplitude;
    input.iter().map(|&x| ((x as f64 - offset) * scale) as f32).collect()
}

/// Ramp in over `attack_proportion` of the samples and ramp out over `decay_proportion`,
/// as `EnvelopeShaper.process` does.
///
/// In-place, because the reference mutates the list it is given.
pub fn apply_envelope(samples: &mut [f32], attack_proportion: f64, decay_proportion: f64) {
    let len = samples.len();
    if len == 0 {
        return;
    }
    let attack_marker = len as f64 * attack_proportion;
    let decay_marker = len as f64 * (1.0 - decay_proportion);

    let mut i = 0usize;
    while (i as f64) < attack_marker {
        let scale = i as f64 / attack_marker;
        samples[i] = (scale * samples[i] as f64) as f32;
        i += 1;
    }

    let mut i = len as isize - 1;
    while (i as f64) > decay_marker && i >= 0 {
        let scale = 1.0 - (i as f64 - decay_marker) / (len as f64 - decay_marker);
        samples[i as usize] = (scale * samples[i as usize] as f64) as f32;
        i -= 1;
    }
}

/// The index of the first sample above `threshold`, or `None`.
///
/// `Cropper.findStart`. Returns `None` rather than the reference's -1, because the reference's
/// -1 reaches `subList` and throws, and the caller swallows that and returns the input
/// uncropped. Callers here decide what an absent start means; see `crop`.
pub fn find_start(samples: &[f32], threshold: f32) -> Option<usize> {
    samples.iter().position(|&x| x > threshold)
}

/// The index of the last sample above `threshold`, or `None`. `Cropper.findEnd`.
pub fn find_end(samples: &[f32], threshold: f32) -> Option<usize> {
    samples.iter().rposition(|&x| x > threshold)
}

/// Crop to the span between the first and last sample above `threshold`.
///
/// Returns the input unchanged when either end is not found. The reference does the same thing
/// by accident: `findStart` returns -1, `subList(-1, end)` throws, the exception is caught, and
/// the un-cropped input is returned. Making it explicit is not a repair, it is the same
/// behaviour with the throw removed, and a caller can see it.
pub fn crop(input: &[f32], threshold: f32) -> &[f32] {
    match (find_start(input, threshold), find_end(input, threshold)) {
        (Some(start), Some(end)) if end > start => &input[start..=end],
        _ => input,
    }
}

/// The samples of each slot the decoder reads, as `Chunker.process` builds them.
///
/// Walks the grid by `TONE_DURATION`, taking `crop_proportion` of each slot. Owned rather than
/// borrowed, because the envelope that follows mutates each chunk in place, as the reference's
/// `EnvelopeShaper` does.
///
/// Pads with a silent chunk when the count is odd, which the reference does too and marks as an
/// ugly hack: the padded chunk is then decoded as a real character, so the last character of an
/// odd-length payload is not meaningful.
pub fn chunk(input: &[f32], crop_proportion: f64, slot: u32) -> Vec<Vec<f32>> {
    let crop_len = (crop_proportion * tables::TONE_DURATION * tables::SAMPLE_RATE as f64) as usize;
    if crop_len == 0 || slot == 0 {
        return Vec::new();
    }
    let mut chunks: Vec<Vec<f32>> = Vec::new();
    let mut start = 0usize;
    while start + crop_len < input.len() {
        chunks.push(input[start..start + crop_len].to_vec());
        // The reference adds `(SILENCE_DURATION + TONE_DURATION) * SAMPLE_RATE`, and
        // SILENCE_DURATION is 0, so this is one slot per step.
        start += slot as usize;
    }
    if chunks.len() % 2 != 0 {
        chunks.push(Vec::new());
    }
    chunks
}

use crate::tables;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_scales_to_a_peak_of_plus_or_minus_one() {
        let out = normalise(&[0.0, 1.0, 2.0, 3.0]);
        let min = out.iter().cloned().fold(f32::MAX, f32::min);
        let max = out.iter().cloned().fold(f32::MIN, f32::max);
        assert!((max - 1.0).abs() < 1e-6, "max was {max}");
        assert!((min + 1.0).abs() < 1e-6, "min was {min}");
    }

    #[test]
    fn normalise_leaves_an_empty_input_alone() {
        assert!(normalise(&[]).is_empty());
    }

    #[test]
    fn normalise_of_a_constant_buffer_is_not_finite_just_as_in_the_reference() {
        // Documented, not fixed: the reference divides by a zero peak-to-peak amplitude here.
        let out = normalise(&[1.0, 1.0, 1.0]);
        assert!(
            out.iter().any(|v| !v.is_finite()),
            "expected the reference's division by zero to survive the port",
        );
    }

    #[test]
    fn the_envelope_silences_the_ends_and_leaves_the_middle() {
        let mut samples = vec![1.0f32; 100];
        apply_envelope(&mut samples, 0.25, 0.25);
        assert_eq!(samples[0], 0.0, "the first sample should be scaled to nothing");
        assert!(samples[50] > 0.9, "the middle should be untouched");
        assert!(samples[99] < samples[50], "the end should be ramped down");
    }

    #[test]
    fn the_envelope_leaves_an_empty_buffer_alone() {
        let mut samples: Vec<f32> = Vec::new();
        apply_envelope(&mut samples, 0.1, 0.1);
        assert!(samples.is_empty());
    }

    #[test]
    fn crop_finds_the_span_between_the_first_and_last_loud_sample() {
        let input = vec![0.0, 0.0, 1.0, 0.0, 1.0, 0.0];
        assert_eq!(crop(&input, 0.5), &[1.0, 0.0, 1.0]);
    }

    #[test]
    fn crop_returns_the_input_when_nothing_crosses_the_threshold() {
        // The reference's silent failure: subList throws, is caught, input returned.
        let input = vec![0.0, 0.0, 0.0];
        assert_eq!(crop(&input, 0.5), &input[..]);
    }

    #[test]
    fn chunk_pads_to_an_even_count() {
        // Seven slots read as seven crops, which is odd, so a silent eighth is appended.
        let slot = tables::tone_slot_samples();
        let crop = tables::crop_samples(tables::CROP_PROPORTION);
        let input = vec![1.0f32; slot as usize * 7];
        let chunks = chunk(&input, tables::CROP_PROPORTION, slot);
        assert_eq!(chunks.len(), 8, "seven crops plus one pad");
        assert_eq!(chunks.len() % 2, 0, "the count must come out even");
        assert!(
            chunks[..7].iter().all(|c| c.len() == crop as usize),
            "each real chunk is one crop long",
        );
        assert!(chunks[7].is_empty(), "the pad is an empty chunk");
    }

    #[test]
    fn chunk_leaves_an_already_even_count_alone() {
        let slot = tables::tone_slot_samples();
        let input = vec![1.0f32; slot as usize * 8];
        let chunks = chunk(&input, tables::CROP_PROPORTION, slot);
        assert_eq!(chunks.len(), 8, "eight crops, no pad needed");
        assert!(chunks.iter().all(|c| !c.is_empty()));
    }

    #[test]
    fn chunk_of_something_shorter_than_a_crop_is_empty() {
        assert!(chunk(&[1.0, 2.0, 3.0], tables::CROP_PROPORTION, 1071).is_empty());
    }
}
