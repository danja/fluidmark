//! wasm/src/roundtrip.rs
//!
//! The whole codec end to end: bytes to tones and back.
//!
//! This is the test that says whether the port is a port. Everything else checks a piece. The
//! reference's decoder is `DefaultDecoder.decode`, whose pipeline is normalise, the optional
//! filters, crop, chunk, the post-processors, then the character codec; the crop is the load
//! bearing step, because it is what removes the silence the encoder padded with and so lines
//! the decoder's crop grid up with the encoder's slots.

use crate::codec;
use crate::signal;
use crate::tables;

/// Decode a waveform the way `DefaultDecoder.decode` does, with the reference's own parameters.
///
/// The normalisation is conditional because `data/config.xml` has it off, and the crop runs on
/// whatever the normalisation produced. With it off, the crop threshold of 0.393 is applied to
/// the raw signal, whose tones sit at amplitude 0.49.
pub fn decode_tones(samples: &[f32], sample_rate: f64) -> Vec<u8> {
    let prepared = if tables::NORMALISE_ON {
        signal::normalise(samples)
    } else {
        samples.to_vec()
    };
    let cropped = signal::crop(&prepared, tables::SILENCE_THRESHOLD as f32);
    let slot = tables::tone_slot_samples();
    let mut chunks = signal::chunk(cropped, tables::CROP_PROPORTION, slot);
    if tables::DECODE_CHUNK_ENV_ON {
        for chunk in chunks.iter_mut() {
            signal::apply_envelope(
                chunk,
                tables::DECODE_CHUNK_ATTACK_PROPORTION,
                tables::DECODE_CHUNK_DECAY_PROPORTION,
            );
        }
    }
    let borrowed: Vec<&[f32]> = chunks.iter().map(|c| c.as_slice()).collect();
    codec::chunks_to_bytes(&borrowed, sample_rate)
}

/// Encode then decode, which is the round trip the CLI tools expose.
pub fn round_trip(bytes: &[u8], sample_rate: f64) -> Vec<u8> {
    decode_tones(&codec::encode_bytes(bytes), sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 22_050.0;

    #[test]
    fn one_byte_survives_the_round_trip() {
        let original = b"A";
        let decoded = round_trip(original, RATE);
        assert_eq!(decoded, original.to_vec());
    }

    #[test]
    fn a_printable_string_survives_the_round_trip() {
        let original = b"abc";
        let decoded = round_trip(original, RATE);
        assert_eq!(decoded, original.to_vec());
    }

    #[test]
    fn two_bytes_survive_the_round_trip() {
        let original = b"hello";
        let decoded = round_trip(original, RATE);
        assert_eq!(decoded, original.to_vec());
    }

    #[test]
    fn every_printable_byte_survives_the_round_trip_on_its_own() {
        // The table covers 8 low tones by 16 high tones, which is exactly 128 values, so the
        // whole printable ASCII range should be representable. Each byte is tested alone,
        // because a failure in a sequence may be a grid problem rather than a mapping problem.
        for b in 0x20u8..0x7f {
            let decoded = round_trip(&[b], RATE);
            assert_eq!(decoded, vec![b], "byte {b:#04x} ({:?}) decoded wrong", b as char);
        }
    }

    #[test]
    fn a_payload_of_several_bytes_survives() {
        for original in [&b"http://danbri.org/"[..], b"abcdefgh", b"Zz09", b"~~~"] {
            let decoded = round_trip(original, RATE);
            assert_eq!(
                decoded,
                original.to_vec(),
                "{:?} decoded wrong",
                String::from_utf8_lossy(original),
            );
        }
    }

    #[test]
    fn silence_decodes_to_nothing_rather_than_to_guesses() {
        // The thing that matters most: no mark in the audio must not come back as a payload.
        assert!(decode_tones(&vec![0.0f32; 44100], RATE).is_empty());
    }

    #[test]
    fn noise_decodes_to_nothing_rather_than_to_guesses() {
        // Deterministic pseudo-noise, so a failure is reproducible. A fixed seed matters: a
        // random buffer that decoded to something once would be a false positive rate question,
        // not a unit test.
        let mut state = 0x1234_5678u32;
        let noise: Vec<f32> = (0..22050)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / 8_388_608.0) - 1.0
            })
            .collect();
        assert!(decode_tones(&noise, RATE).is_empty());
    }

    #[test]
    fn the_encoder_pads_and_the_cropper_removes_the_padding() {
        // Without the crop the decoder would slice across the padding and read the first chunk
        // as silence, so every character would be wrong. This is the ordering that matters.
        let tones = codec::encode_bytes(b"A");
        assert!(tones.iter().take(100).all(|&x| x == 0.0), "the encoder pads silence");
        let cropped = signal::crop(&tones, tables::SILENCE_THRESHOLD as f32);
        assert!(
            cropped.len() < tones.len(),
            "the cropper should remove the padding: {} of {}",
            cropped.len(),
            tones.len(),
        );
    }

    #[test]
    fn decoding_is_not_sensitive_to_being_run_twice() {
        let decoded = round_trip(b"abc", RATE);
        assert_eq!(decoded, round_trip(b"abc", RATE));
    }
}

    #[test]
    fn inspect_at_sign() {
        let tones = codec::encode_bytes(b"@");
        let cropped = signal::crop(&tones, tables::SILENCE_THRESHOLD as f32);
        println!("tones {} cropped {}", tones.len(), cropped.len());
        let chunks = signal::chunk(cropped, tables::CROP_PROPORTION, tables::tone_slot_samples());
        println!("chunks {}", chunks.len());
        for (i, c) in chunks.iter().enumerate() {
            let f = crate::pitch::find_pitches_default(c);
            println!("  crop {i}: {} samples peak {:.4} detected {:?}", c.len(),
                c.iter().cloned().fold(0.0f32, f32::max), f);
        }
    }
