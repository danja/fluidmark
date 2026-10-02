//! wasm/src/codec.rs
//!
//! The text codec, ported from `reference/WebBeep`'s `ASCIICodec.java`, `CharacterDecoder.java`
//! and `WaveMaker.java`.
//!
//! The payload layer itself, punycode and the checksum, is not here: it is a text concern and
//! belongs on the JavaScript side, which has the platform built-ins for it. What is here is
//! everything that turns bytes into tones and tones back into bytes.

use crate::pitch;
use crate::signal;
use crate::tables;

/// A sine of `freq` for `duration` seconds, as `WaveMaker.makeWaveform` makes it.
fn waveform(freq: f64, amplitude: f64, duration: f64) -> Vec<f32> {
    let n = (tables::SAMPLE_RATE as f64 * duration) as usize;
    (0..n)
        .map(|i| {
            (amplitude * (2.0 * std::f64::consts::PI * freq * i as f64 / tables::SAMPLE_RATE as f64).sin())
                as f32
        })
        .collect()
}

/// A sine with the encode envelope on it, as `WaveMaker.makeShapedWaveform` makes it.
fn shaped_waveform(freq: f64, amplitude: f64, duration: f64) -> Vec<f32> {
    let mut samples = waveform(freq, amplitude, duration);
    signal::apply_envelope(
        &mut samples,
        tables::ENCODE_ATTACK_PROPORTION,
        tables::ENCODE_DECAY_PROPORTION,
    );
    samples
}

/// Silence, as `WaveMaker.makeSilence` makes it.
fn silence(duration: f64) -> Vec<f32> {
    vec![0.0; (tables::SAMPLE_RATE as f64 * duration) as usize]
}

/// One tone, long if `beats` is 1 and short followed by silence if it is 2.
///
/// The reference's comment on the beat arrays: "2 is actually half-length". So the length of a
/// tone carries information as well as its frequency, and a tone that is short is followed by
/// silence for the remainder of its slot.
fn tone(index: usize, duration: f64) -> Vec<f32> {
    let freq = tables::freq_for(index);
    if tables::beats_for(index) == 1 {
        shaped_waveform(freq, tables::AMPLITUDE, duration * 2.0)
    } else {
        let mut out = shaped_waveform(freq, tables::AMPLITUDE, duration);
        out.extend(silence(duration));
        out
    }
}

/// One chunk: the low tone for the byte's high nibble and the high tone for its low nibble,
/// summed, as `WaveMaker.makeDualtone` makes it.
pub fn dual_tone(low_index: usize, high_index: usize, duration: f64) -> Vec<f32> {
    let mut data_low = tone(low_index, duration);
    let data_high = tone(tables::LOW_FREQ.len() + high_index, duration);
    for (i, &sample) in data_high.iter().enumerate() {
        if i < data_low.len() {
            data_low[i] += sample;
        }
    }
    data_low
}

/// Every byte as its chunks, as `ASCIICodec.asciiToChunks` makes it.
///
/// The byte is split into nibbles: the low nibble picks the high tone and the high nibble picks
/// the low tone. The reference's field names are the other way round, which is worth knowing
/// before reading either.
pub fn bytes_to_chunks(bytes: &[u8]) -> Vec<Vec<f32>> {
    bytes
        .iter()
        .map(|&b| {
            let ls = (b % 16) as usize;
            let ms = ((b - b % 16) / 16) as usize;
            dual_tone(ms, ls, tables::TONE_DURATION)
        })
        .collect()
}

/// The tones for a payload, with the reference's silence padding at each end.
///
/// `DefaultEncoder` adds a second of silence at each end; `Merger` adds `START_PAD_DURATION`
/// and `END_PAD_DURATION`. Both are ported, in that order, because the decoder's cropper
/// threshold finds the start against them.
pub fn encode_bytes(bytes: &[u8]) -> Vec<f32> {
    let chunks = bytes_to_chunks(bytes);
    let mut merged: Vec<f32> = Vec::new();
    for chunk in chunks {
        merged.extend(chunk);
    }

    let mut out = silence(tables::START_PAD_DURATION);
    out.extend(merged);
    out.extend(silence(tables::END_PAD_DURATION));
    out
}

/// Reconstruct one character from a pair of chunks, as `CharacterDecoder.decodeChar` does.
///
/// The left chunk gives the two frequencies, so the low and high notes. The right chunk gives
/// how long each was: two pitches means both ran long, none means both were short, and one
/// means one of the pair ran long and the other short. Each note's frequency and its duration
/// together then identify one entry in that note's own table, and the two entries are the
/// nibbles of the byte.
///
/// Where the reference takes the first two detections and swaps them if they arrived
/// high-then-low, this sorts the detections by frequency. Same result, and it does not depend
/// on the order the detections came out in.
pub fn chunk_pair_to_byte(left: &[f32], right: &[f32], sample_rate: f64) -> Option<u8> {
    let left_found = pitch::find_pitches(left, sample_rate, tables::GOERTZEL_THRESHOLD);
    let right_found = pitch::find_pitches(right, sample_rate, tables::GOERTZEL_THRESHOLD);

    let mut freqs = left_found;
    freqs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let low_note = *freqs.first()?;
    let high_note = *freqs.last()?;

    let (beat_low, beat_high) = match right_found.len() {
        2 => (1, 1),
        0 => (2, 2),
        1 => {
            let right_note = right_found[0];
            if right_note == low_note {
                (1, 2)
            } else if right_note == high_note {
                (2, 1)
            } else {
                (0, 0)
            }
        }
        _ => (0, 0),
    };
    if beat_low == 0 || beat_high == 0 {
        return None;
    }

    // Each note is looked up in its own table, as the reference does with two separate calls
    // to `Maps.unmapValue`, so both indices are local to their array and combine as
    // `low * 16 + high`.
    let low_index = table_index(&tables::LOW_FREQ, &tables::LOW_BEATS, low_note, beat_low)?;
    let high_index = table_index(&tables::HIGH_FREQ, &tables::HIGH_BEATS, high_note, beat_high)?;
    Some(((low_index * 16 + high_index) as u8).to_owned())
}

/// The index whose frequency is `freq` and whose duration is `beat`, in one table.
///
/// The reference throws where this returns `None`, and its caller catches that and logs
/// "No character matched". Same outcome, without the exception.
fn table_index(freqs: &[f64], beats: &[u32], freq: f64, beat: u32) -> Option<usize> {
    freqs
        .iter()
        .zip(beats.iter())
        .position(|(&f, &b)| f == freq && b == beat)
}

/// Chunks back to bytes, as `ASCIICodec.chunksToASCII` does.
///
/// The reference walks the chunk list two at a time and builds one character from each pair,
/// dropping the final chunk when the count is odd. A byte therefore costs two chunk slots, and
/// `bytes_to_chunks` must produce them in pairs to match.
pub fn chunks_to_bytes(chunks: &[&[f32]], sample_rate: f64) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < chunks.len() {
        if let Some(b) = chunk_pair_to_byte(chunks[i], chunks[i + 1], sample_rate) {
            out.push(b);
        }
        i += 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_byte_becomes_the_expected_two_tones() {
        // 'A' is 65: high nibble 4, low nibble 1.
        let chunk = dual_tone(4, 1, tables::TONE_DURATION);
        assert!(!chunk.is_empty());
        let found = pitch::find_pitches_default(&chunk);
        assert!(found.contains(&tables::LOW_FREQ[4]), "should find low tone 4, got {found:?}");
        assert!(found.contains(&tables::HIGH_FREQ[1]), "should find high tone 1, got {found:?}");
    }

    #[test]
    fn a_long_tone_fills_its_slot_and_a_short_one_leaves_silence() {
        // LOW_BEATS[0] is 1, so index 0 is long: two slots of tone.
        let long = tone(0, tables::TONE_DURATION);
        // LOW_BEATS[5] is 2, so index 5 is short: a tone then silence.
        let short = tone(5, tables::TONE_DURATION);
        assert!(
            short.iter().rev().take(100).all(|&x| x == 0.0),
            "a short tone ends in silence",
        );
        assert!(
            short[..100].iter().any(|&x| x != 0.0),
            "a short tone starts with tone",
        );
        // Both span the same time, to within the truncation the reference's integer casts also
        // introduce: 22050 * 0.048611111 * 2 truncates to 2143, and 1071 + 1071 is 2142.
        assert!(
            long.len().abs_diff(short.len()) <= 1,
            "long {} short {}",
            long.len(),
            short.len(),
        );
    }

    #[test]
    fn the_encoder_makes_one_dual_tone_per_byte_spanning_two_slots() {
        // One chunk per byte here, each two slots long. The decoder works in the other
        // direction: it re-slices the whole signal into crops one slot apart, so it gets
        // roughly two crops per byte and pairs those. The two granularities are different and
        // the decoder's crop step, not this function, is what lines them up.
        let chunks = bytes_to_chunks(b"ab");
        assert_eq!(chunks.len(), 2, "one dual tone per byte");
        let slot = tables::tone_slot_samples() as usize;
        assert!(
            (chunks[0].len() as i64 - (2 * slot) as i64).abs() <= 1,
            "a chunk spans two slots, got {}",
            chunks[0].len(),
        );
    }

    #[test]
    fn encoding_pads_at_both_ends() {
        let bare = bytes_to_chunks(b"a").concat();
        let padded = encode_bytes(b"a");
        assert!(padded.len() > bare.len());
        let pad = silence(tables::START_PAD_DURATION).len();
        assert_eq!(&padded[..pad], &vec![0.0f32; pad][..], "starts with silence");
        assert_eq!(&padded[padded.len() - pad..], &vec![0.0f32; pad][..], "ends with silence");
    }

    #[test]
    fn silence_is_silence() {
        assert!(silence(0.001).iter().all(|&x| x == 0.0));
        assert_eq!(silence(0.001).len(), 22);
    }
}