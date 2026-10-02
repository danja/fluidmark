//! wasm/src/tables.rs
//!
//! The tone tables and the constants, ported from `reference/WebBeep`'s `config/Maps.java`
//! and `config/Constants.java`.
//!
//! One source of truth. The pitch finder and the encoder are the only consumers, and both are
//! in this crate, so nothing here has to cross the boundary to be used. What does cross is the
//! decoded byte values, which is why the table stays here rather than being duplicated in
//! JavaScript.

/// Sample rate for the whole system, in Hz. The reference comments say "44.1kHz" in the preset
/// block and then sets 22050; the constant is the truth and 22050 is what its output uses.
pub const SAMPLE_RATE: u32 = 22_050;

/// Amplitude of each generated tone, before the two tones of a chunk are summed.
pub const AMPLITUDE: f64 = 0.49;

/// Peak sample value for 16-bit PCM.
pub const MAX_VALUE: f64 = 32_767.0;

/// Duration of one chunk's slot, in seconds.
pub const TONE_DURATION: f64 = 0.048_611_111;

/// Silence between tones. The reference sets this to 0 and notes in a comment that
/// tone/tone/gap is not handled correctly.
pub const SILENCE_DURATION: f64 = 0.0;

/// Silence `Merger` puts before and after the tones.
pub const START_PAD_DURATION: f64 = 0.072_916_666_7;
pub const END_PAD_DURATION: f64 = 0.145_833_333;

/// Attack and decay of the envelope `WaveMaker` puts on every generated tone.
pub const ENCODE_ATTACK_PROPORTION: f64 = 0.0625;
pub const ENCODE_DECAY_PROPORTION: f64 = 0.125;

// The three decoder parameters below, and `NORMALISE_ON`, are **not** the defaults in the
// reference's `config/Constants.java`. They are the values in `data/config.xml`, which its
// genetic algorithm produced and which is the configuration the reference actually runs with.
//
// The difference is not cosmetic. With the Constants.java defaults the round trip does not work:
// `SILENCE_THRESHOLD` of 0.5 against a signal normalised to +/-1 trims the envelope ramps off
// the front and back of the tones, which shifts the decoder's crop grid off the encoder's slot
// grid by however long the ramps are, and every character after the first is read from the
// wrong place. Turning normalisation off and thresholding at 0.393 against the raw signal, whose
// tones sit at amplitude 0.49, makes the crop find the true first and last tone sample.
//
// So these are part of the algorithm, not configuration. Changing one changes what decodes.

/// Whether the decoder normalises before cropping.
///
/// False, per `data/config.xml`. The reference's `DefaultDecoder.decode` always runs a
/// `Normalise`, but the parameter is off in the configuration it ships with, so it returns the
/// input unchanged.
pub const NORMALISE_ON: bool = false;

/// Below this level the decoder treats a sample as silence when finding the start and end.
pub const SILENCE_THRESHOLD: f64 = 0.393_289_637_023_258;

/// How much of each chunk's slot the decoder reads, as a proportion of `TONE_DURATION`.
pub const CROP_PROPORTION: f64 = 0.633_772_490_135_606_9;

/// Goertzel power above which the pitch finder calls a frequency present.
pub const GOERTZEL_THRESHOLD: f64 = 4_194.939_772_585_178;

/// Attack and decay of the envelope the decoder applies to each chunk, which
/// `Decoder.post.chunkEnv.on` turns on.
pub const DECODE_CHUNK_ENV_ON: bool = true;
pub const DECODE_CHUNK_ATTACK_PROPORTION: f64 = 0.14;
pub const DECODE_CHUNK_DECAY_PROPORTION: f64 = 0.091;

// Low tones. C D E G A, then two more octaves used by the upper half of the byte.
pub const LOW_FREQ: [f64; 8] = [261.63, 293.66, 329.63, 392.0, 440.0, 261.63, 293.66, 392.0];

/// Duration of each low tone, in beats. The reference's comment: "2 is actually half-length".
pub const LOW_BEATS: [u32; 8] = [1, 1, 1, 1, 1, 2, 2, 2];

// High tones. The same scale an octave and a bit higher.
pub const HIGH_FREQ: [f64; 16] = [
    523.25, 587.33, 659.26, 783.99, 880.0, 523.25, 587.33, 659.26, 783.99, 880.0, 1046.5, 1174.66,
    1318.51, 1567.98, 1760.0, 1567.98,
];

pub const HIGH_BEATS: [u32; 16] = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2];

/// Note names, for diagnostics only. The reference lower-cases the high ones.
pub const LOW_ABC: [&str; 8] = ["C", "D", "E", "G", "A", "C", "D", "G"];
pub const HIGH_ABC: [&str; 16] = [
    "c", "d", "e", "g", "a", "c", "d", "e", "g", "a", "c'", "d'", "e'", "g'", "a'", "g'",
];

/// Every frequency the pitch finder looks for, low tones first.
pub fn all_freqs() -> Vec<f64> {
    LOW_FREQ.iter().chain(HIGH_FREQ.iter()).copied().collect()
}

/// Samples in one chunk slot, which is the grid the decoder slices on.
pub fn tone_slot_samples() -> u32 {
    (TONE_DURATION * SAMPLE_RATE as f64) as u32
}

/// Samples the decoder reads from each slot.
pub fn crop_samples(crop_proportion: f64) -> u32 {
    (crop_proportion * TONE_DURATION * SAMPLE_RATE as f64) as u32
}

/// The beats entry for a table index, or 0 if the index is out of range.
pub fn beats_for(index: usize) -> u32 {
    match index {
        i if i < LOW_BEATS.len() => LOW_BEATS[i],
        i if i - LOW_BEATS.len() < HIGH_BEATS.len() => HIGH_BEATS[i - LOW_BEATS.len()],
        _ => 0,
    }
}

/// The frequency for a table index, or 0.0 if the index is out of range.
pub fn freq_for(index: usize) -> f64 {
    match index {
        i if i < LOW_FREQ.len() => LOW_FREQ[i],
        i if i - LOW_FREQ.len() < HIGH_FREQ.len() => HIGH_FREQ[i - LOW_FREQ.len()],
        _ => 0.0,
    }
}

/// Index of a frequency in the table, or `None`.
///
/// The reference compares frequencies for exact `double` equality, which works only because its
/// finder reports table values rather than measured ones. Here the lookup takes the index the
/// finder returned, so the equality is between two integers and the check is real.
pub fn index_of(freq: f64) -> Option<usize> {
    all_freqs().iter().position(|&f| f == freq)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tables_are_the_lengths_the_codec_assumes() {
        // The codec splits a byte into two nibbles: the high nibble indexes the low table,
        // which must therefore cover 0..8 for the whole 7-bit range to be encodable.
        assert_eq!(LOW_FREQ.len(), 8);
        assert_eq!(HIGH_FREQ.len(), 16);
        assert_eq!(LOW_BEATS.len(), LOW_FREQ.len());
        assert_eq!(HIGH_BEATS.len(), HIGH_FREQ.len());
        assert_eq!(all_freqs().len(), 24);
    }

    #[test]
    fn every_index_a_byte_can_produce_has_a_frequency_and_a_duration() {
        for high in 0..8usize {
            for low in 0..16usize {
                assert!(freq_for(high) > 0.0, "no low frequency for index {high}");
                assert!(freq_for(LOW_FREQ.len() + low) > 0.0, "no high frequency for {low}");
                assert!(beats_for(high) >= 1, "no low duration for index {high}");
                assert!(beats_for(LOW_FREQ.len() + low) >= 1, "no high duration for {low}");
            }
        }
    }

    #[test]
    fn out_of_range_indices_are_refused_rather_than_wrapping() {
        assert_eq!(freq_for(all_freqs().len()), 0.0);
        assert_eq!(beats_for(all_freqs().len()), 0);
        assert_eq!(freq_for(9999), 0.0);
    }

    #[test]
    fn the_slot_grid_matches_the_sample_rate() {
        // 0.048611111 s at 22050 Hz, which is what the chunker slices on.
        assert_eq!(tone_slot_samples(), 1071);
        // 0.6337724901356069 of a slot, the value from data/config.xml rather than the 0.5 in
        // Constants.java. Both are recorded so a change to either is visible in a diff.
        assert_eq!(crop_samples(0.5), 535);
        assert_eq!(crop_samples(CROP_PROPORTION), 679);
    }

    #[test]
    fn the_crop_does_not_reach_past_the_slot_it_belongs_to() {
        // A crop longer than its slot would read into the neighbouring slot, which is how the
        // decoder learns a tone's duration. A crop shorter than the tone means it never hears
        // the silence that says the tone was short.
        let slot = tone_slot_samples();
        let crop = crop_samples(CROP_PROPORTION);
        assert!(crop < slot, "crop {crop} must be shorter than slot {slot}");
        assert!(crop as f64 / slot as f64 > 0.5, "and long enough to contain a tone's attack");
    }

    #[test]
    fn a_frequency_maps_back_to_its_index() {
        assert_eq!(index_of(261.63), Some(0));
        assert_eq!(index_of(1760.0), Some(22));
        assert_eq!(index_of(999.0), None);
    }
}