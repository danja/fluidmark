//! wasm/src/attack.rs
//!
//! The attacks a watermark has to survive, and the measurement of what survives them.
//!
//! Built before any scheme, on the reasoning in `docs/steganography.md`: a harness written
//! after the algorithm exists will have been written to prove the algorithm works. This one is
//! calibrated against the LSB baseline, whose expected behaviour is documented, so a number from
//! it means something.
//!
//! The list is the brief's, not a list chosen after seeing results: significant processing and
//! degradation in the time and frequency domains. Transcoding, resampling, gain, dither,
//! filtering, time shift, crop, stereo to mono, and a DAW render cycle. The first and last of
//! those need external tools and live in `bin/attack.js` rather than here, because shelling out
//! is not something a core should do.
//!
//! Bit error rate is measured against the frame that went in, not against whatever decoded. A
//! frame that fails its checksum still has a bit error rate, and that rate is the measurement.

use crate::lfs;

/// Multiply every sample by a linear gain.
pub fn gain(samples: &[f32], decibels: f32) -> Vec<f32> {
    let factor = 10f32.powf(decibels / 20.0);
    samples.iter().map(|&x| x * factor).collect()
}

/// Add uniform noise at a given signal-to-noise ratio, then round to 16-bit.
///
/// Rounding is part of the attack, not a detail of it: dither followed by quantisation is what
/// destroys a low-bit scheme, and a harness that adds noise without quantising flatters it.
pub fn dither(samples: &[f32], snr_db: f32, seed: u64) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let peak = samples.iter().fold(0.0f32, |acc, &x| acc.max(x.abs())).max(1e-9);
    let amplitude = peak * 10f32.powf(-snr_db / 20.0);
    let mut state = seed | 1;
    samples
        .iter()
        .map(|&x| {
            // Uniform in -1..1 from the top bits, which is good enough for a dither source.
            let noise = (next_uniform(&mut state) * 2.0 - 1.0) * amplitude;
            quantise16(x + noise)
        })
        .collect()
}

/// Round to 16-bit steps, which is what a WAV file stores.
///
/// Scaling by 32768, a power of two, so the step is exact and a value on a step boundary is not
/// pushed off it. The same scaling `wasm/src/lfs.rs` uses, and the two have to agree: an embedder
/// that quantises one way and an attacker another loses bits for no reason.
pub fn quantise16(sample: f32) -> f32 {
    let steps = 32768.0;
    (sample * steps).round() / steps
}

/// Resample by a ratio, band-limiting first when downsampling.
///
/// The low-pass before decimation is not decoration: interpolating without it aliases, and an
/// attack that aliases is attacking something no real resampler does. The cutoff is well below
/// the new Nyquist rather than exactly at it, because a real resampler's transition band eats
/// into it.
pub fn resample(samples: &[f32], ratio: f32, sample_rate: f32) -> Vec<f32> {
    if samples.is_empty() || ratio <= 0.0 {
        return samples.to_vec();
    }
    let prepared: Vec<f32> = if ratio < 1.0 {
        lowpass(samples, sample_rate * ratio * 0.45, sample_rate)
    } else {
        samples.to_vec()
    };
    let out_len = ((samples.len() as f32) * ratio).round().max(1.0) as usize;
    let step = 1.0 / ratio;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f32 * step;
        let index = position.floor() as usize;
        if index + 1 >= prepared.len() {
            out.push(*prepared.last().unwrap_or(&0.0));
        } else {
            let t = position - index as f32;
            let a = prepared[index];
            let b = prepared[index + 1];
            out.push(a + (b - a) * t);
        }
    }
    out
}

/// Coefficients for one second-order section: `[b0, b1, b2, a1, a2]`.
fn section(cutoff: f32, sample_rate: f32, high_pass: bool) -> [f32; 5] {
    let w = 2.0 * std::f32::consts::PI * cutoff / sample_rate;
    let (s, c) = w.sin_cos();
    let alpha = s / (2.0 * (2f32.sqrt() / 2.0));
    let a0 = 1.0 + alpha;
    if high_pass {
        let a1 = -2.0 * c;
        let a2 = 1.0 - alpha;
        [
            ((1.0 + c) / 2.0) / a0,
            (-(1.0 + c)) / a0,
            ((1.0 + c) / 2.0) / a0,
            a1 / a0,
            a2 / a0,
        ]
    } else {
        let a1 = -2.0 * c;
        let a2 = 1.0 - alpha;
        [
            ((1.0 - c) / 2.0) / a0,
            (1.0 - c) / a0,
            ((1.0 - c) / 2.0) / a0,
            a1 / a0,
            a2 / a0,
        ]
    }
}

fn run_section(samples: &[f32], k: [f32; 5]) -> Vec<f32> {
    let [b0, b1, b2, a1, a2] = k;
    let mut x1 = 0.0f32;
    let mut x2 = 0.0f32;
    let mut y1 = 0.0f32;
    let mut y2 = 0.0f32;
    let mut out = Vec::with_capacity(samples.len());
    for &x in samples {
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out.push(y);
    }
    out
}

/// A second-order low-pass, two sections cascaded, so the roll-off is like a real filter's.
///
/// `cutoff` in Hz, `sample_rate` in Hz. A one-pole would be easier and is what a naive harness
/// uses, and it barely touches a tone at a few times its cutoff, which makes the filter attack
/// look survivable when a real EQ would not.
pub fn lowpass(samples: &[f32], cutoff: f32, sample_rate: f32) -> Vec<f32> {
    let k = section(cutoff, sample_rate, false);
    run_section(&run_section(samples, k), k)
}

/// A second-order high-pass, matching `lowpass`.
pub fn highpass(samples: &[f32], cutoff: f32, sample_rate: f32) -> Vec<f32> {
    let k = section(cutoff, sample_rate, true);
    run_section(&run_section(samples, k), k)
}

/// A crude peaking EQ at one frequency, in dB.
pub fn equalise(samples: &[f32], frequency: f32, gain_db: f32, sample_rate: f32) -> Vec<f32> {
    // A notch-free two-tap: a resonator that boosts energy near one frequency, which is what a
    // mixer's sweep does at its extremes.
    let w = 2.0 * std::f32::consts::PI * frequency / sample_rate;
    let (s, c) = w.sin_cos();
    let r = 0.98;
    let a1 = 2.0 * r * c;
    let gain = 10f32.powf(gain_db / 20.0);
    let mut y1 = 0.0f32;
    let mut y2 = 0.0f32;
    let mut out = Vec::with_capacity(samples.len());
    for &x in samples {
        let y = gain * x + a1 * y1 - r * r * y2;
        y2 = y1;
        y1 = y;
        out.push(y);
    }
    let _ = s;
    out
}

/// Drop everything outside `from`..`to` in samples.
pub fn crop(samples: &[f32], from: usize, to: usize) -> Vec<f32> {
    let from = from.min(samples.len());
    let to = to.min(samples.len()).max(from);
    samples[from..to].to_vec()
}

/// Shift the whole signal by `samples`, padding with silence at the front.
pub fn time_shift(samples: &[f32], by: usize) -> Vec<f32> {
    let mut out = vec![0.0; by.min(samples.len() + by)];
    out.extend_from_slice(samples);
    out.truncate(samples.len() + by);
    out
}

/// Fold stereo to mono.
///
/// Averaging, which loses 3 dB of a correlated pair and cancels an inverted one. That is what a
/// player does and what a checker does, so it belongs here.
pub fn stereo_to_mono(left: &[f32], right: &[f32]) -> Vec<f32> {
    let n = left.len().min(right.len());
    (0..n).map(|i| (left[i] + right[i]) * 0.5).collect()
}

/// White noise at a given signal-to-noise ratio.
pub fn white_noise(samples: &[f32], snr_db: f32, seed: u64) -> Vec<f32> {
    let peak = samples.iter().fold(0.0f32, |acc, &x| acc.max(x.abs())).max(1e-9);
    let amplitude = peak * 10f32.powf(-snr_db / 20.0);
    let mut state = seed | 1;
    samples
        .iter()
        .map(|&x| x + (next_uniform(&mut state) * 2.0 - 1.0) * amplitude)
        .collect()
}

/// Pink noise, by the Voss-McCartney approximation, at a given SNR.
pub fn pink_noise(samples: &[f32], snr_db: f32, seed: u64) -> Vec<f32> {
    let peak = samples.iter().fold(0.0f32, |acc, &x| acc.max(x.abs())).max(1e-9);
    let amplitude = peak * 10f32.powf(-snr_db / 20.0);
    let mut state = seed | 1;
    let mut rows = [0.0f32; 16];
    let mut running = 0.0f32;
    samples
        .iter()
        .map(|&x| {
            let mut counter = 0usize;
            let mut value = next_uniform(&mut state);
            while counter < 16 {
                if counter.trailing_zeros() as usize == 0 {
                    running -= rows[counter];
                    rows[counter] = value * 0.5;
                    running += rows[counter];
                }
                counter += 1;
                value = next_uniform(&mut state);
            }
            x + running * amplitude * 4.0
        })
        .collect()
}

fn next_uniform(state: &mut u64) -> f32 {
    // xorshift64*, which is enough for noise and much cheaper than SplitMix.
    let mut x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    ((x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 40) as f32) / 8_388_608.0
}

/// What happened to a frame that went through an attack.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub name: String,
    /// Bits differing from the frame that went in.
    pub bit_errors: usize,
    /// Total bits in that frame.
    pub bits: usize,
    /// Whether the recovered frame decoded.
    pub decoded: bool,
    /// Why it did not, when it did not.
    pub reason: String,
}

impl Outcome {
    /// Bit error rate as a fraction, which is the number to compare between schemes.
    pub fn ber(&self) -> f64 {
        if self.bits == 0 {
            return 1.0;
        }
        self.bit_errors as f64 / self.bits as f64
    }
}

/// Run one attack over a marked signal and report what survived.
///
/// `frame_bytes` is how much to read back, which the reader is told out of band for LSB because
/// LSB has no sync word to find the start with.
pub fn measure(
    name: &str,
    original_frame: &[u8],
    key: u64,
    attacked: &[f32],
) -> Outcome {
    let recovered = lfs::extract(attacked, original_frame.len(), key);
    let bit_errors = lfs::bit_errors(original_frame, &recovered);
    let bits = original_frame.len() * 8;
    let (decoded, reason) = match crate::frame::decode(&recovered) {
        Ok(_) => (true, String::new()),
        Err(e) => (false, format!("{e:?}")),
    };
    Outcome {
        name: name.to_string(),
        bit_errors,
        bits,
        decoded,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 44_100.0;

    fn audio(len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let t = i as f32 / RATE;
                0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() + 0.2 * (2.0 * std::f32::consts::PI * 100.0 * t).sin()
            })
            .collect()
    }

    fn frame(len: usize) -> Vec<u8> {
        crate::frame::encode(&(0..len).map(|i| (i * 31 + 7) as u8).collect::<Vec<u8>>(), 0)
    }

    #[test]
    fn gain_changes_the_level_and_nothing_else() {
        let input = audio(1000);
        let quiet = gain(&input, -6.0);
        assert!((quiet[100] - input[100] * 10f32.powf(-6.0 / 20.0)).abs() < 1e-6);
        assert!(quiet.iter().all(|&x| x.abs() < 1.0));
    }

    #[test]
    fn quantisation_snaps_to_the_nearest_16_bit_value() {
        let step = 1.0 / 32768.0;
        // A value already on a step is untouched, which is the property that matters: an
        // embedder and an attacker that quantise differently lose bits for no reason.
        assert_eq!(quantise16(0.5), 0.5);
        assert_eq!(quantise16(0.0), 0.0);
        // A value off a step moves to the nearest one, and by no more than half a step.
        let nudged = quantise16(0.501);
        assert!((nudged - 0.501).abs() <= step / 2.0, "moved by {}", (nudged - 0.501).abs());
        assert_ne!(nudged, 0.501, "0.501 is not on a 16-bit step");
    }

    #[test]
    fn resampling_changes_the_length_by_the_ratio() {
        let input = audio(1000);
        assert_eq!(resample(&input, 0.5, RATE).len(), 500);
        assert_eq!(resample(&input, 2.0, RATE).len(), 2000);
    }

    #[test]
    fn resampling_a_signal_above_its_new_nyquist_destroys_it() {
        // A 20 kHz tone downsampled to 22050 Hz has nothing above 11025 left to carry it, which
        // is the whole reason a tone-based mark and a sample-based one both die here.
        let high: Vec<f32> = (0..4410)
            .map(|i| (2.0 * std::f32::consts::PI * 20000.0 * i as f32 / RATE).sin())
            .collect();
        let out = resample(&high, 0.5, RATE);
        let peak_after = out.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak_after < 0.5, "peak fell from ~1 to {peak_after}");
    }

    #[test]
    fn a_lowpass_removes_a_tone_above_its_cutoff() {
        let high: Vec<f32> = (0..44100)
            .map(|i| (2.0 * std::f32::consts::PI * 8000.0 * i as f32 / RATE).sin())
            .collect();
        let filtered = lowpass(&high, 1000.0, RATE);
        let peak = filtered[2000..].iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak < 0.1, "an 8 kHz tone should be gone, peak {peak}");
    }

    #[test]
    fn a_highpass_removes_a_tone_below_its_cutoff() {
        let low: Vec<f32> = (0..44100)
            .map(|i| (2.0 * std::f32::consts::PI * 50.0 * i as f32 / RATE).sin())
            .collect();
        let filtered = highpass(&low, 1000.0, RATE);
        let peak = filtered[2000..].iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak < 0.1, "a 50 Hz tone should be gone, peak {peak}");
    }

    #[test]
    fn crop_removes_the_ends() {
        assert_eq!(crop(&[1.0, 2.0, 3.0, 4.0], 1, 3), vec![2.0, 3.0]);
    }

    #[test]
    fn time_shift_moves_the_signal_later_and_pads_with_silence() {
        let out = time_shift(&[1.0, 2.0, 3.0], 2);
        assert_eq!(out, vec![0.0, 0.0, 1.0, 2.0, 3.0]);
    }

    #[test]
    fn stereo_folding_cancels_an_inverted_pair() {
        assert_eq!(stereo_to_mono(&[1.0, 0.0], &[-1.0, 0.0]), vec![0.0, 0.0]);
    }

    #[test]
    fn a_clean_round_trip_has_no_bit_errors() {
        let samples = audio(44100);
        let f = frame(32);
        let marked = lfs::embed(&samples, &f, 42);
        let outcome = measure("none", &f, 42, &marked);
        assert_eq!(outcome.bit_errors, 0);
        assert_eq!(outcome.ber(), 0.0);
        assert!(outcome.decoded);
    }

    #[test]
    fn dithering_destroys_a_low_bit_scheme_as_the_literature_says() {
        // This is the harness calibrated. If LSB survived this, the harness is not measuring
        // what it claims to.
        let samples = audio(44100);
        let f = frame(32);
        let marked = lfs::embed(&samples, &f, 42);
        let attacked = dither(&marked, 40.0, 1);
        let outcome = measure("dither 40 dB", &f, 42, &attacked);
        assert!(
            outcome.ber() > 0.2,
            "expected dither to wreck a low-bit scheme, got BER {:.3}",
            outcome.ber(),
        );
    }

    #[test]
    fn resampling_destroys_a_low_bit_scheme() {
        let samples = audio(44100);
        let f = frame(32);
        let marked = lfs::embed(&samples, &f, 42);
        let attacked = resample(&marked, 44100.0 / 48000.0, 44100.0);
        let outcome = measure("resample 48k", &f, 42, &attacked);
        assert!(outcome.ber() > 0.3, "expected resampling to destroy it, got {:.3}", outcome.ber());
    }

    #[test]
    fn even_a_small_gain_change_destroys_a_low_bit_scheme() {
        // The reasoning this replaces was that -6 dB is "exactly representable in 16-bit steps".
        // It is not: scaling moves every sample off the 16-bit grid, so the low bit becomes
        // whatever the rounding leaves behind. That is why the survey lists gain and
        // normalisation among the things that destroy sample-bit schemes, and it is a reminder
        // that a plausible-sounding reason to expect survival is not a measurement.
        let samples = audio(44100);
        let f = frame(32);
        let marked = lfs::embed(&samples, &f, 42);
        for decibels in [-6.0f32, -0.5, 3.0] {
            let attacked = quantise16_pass(gain(&marked, decibels));
            let outcome = measure(&format!("gain {decibels} dB"), &f, 42, &attacked);
            assert!(
                outcome.ber() > 0.4,
                "gain of {decibels} dB gave BER {:.3}, expected it to wreck a low-bit scheme",
                outcome.ber(),
            );
        }
    }

    #[test]
    fn leaving_the_audio_alone_keeps_every_bit() {
        // The control for the test above: with no attack at all, nothing is lost. Without it, a
        // harness could report "destroyed" for everything and look like it was working.
        let samples = audio(44100);
        let f = frame(32);
        let marked = lfs::embed(&samples, &f, 42);
        let outcome = measure("untouched", &f, 42, &marked);
        assert_eq!(outcome.ber(), 0.0);
        assert!(outcome.decoded);
    }

    /// Round to 16-bit steps without adding noise.
    fn quantise16_pass(samples: Vec<f32>) -> Vec<f32> {
        samples.into_iter().map(quantise16).collect()
    }
    #[test]
    fn probe_clean_round_trip() {
        let samples: Vec<f32> = (0..44100).map(|i| {
            let t = i as f32 / 44100.0;
            0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() + 0.2 * (2.0 * std::f32::consts::PI * 100.0 * t).sin()
        }).collect();
        println!("audio built");
        let f = crate::frame::encode(&(0..32).map(|i| (i * 31 + 7) as u8).collect::<Vec<u8>>(), 0);
        println!("frame {} bytes", f.len());
        let marked = lfs::embed(&samples, &f, 42);
        println!("embedded {} -> {}", f.len(), marked.len());
        let rec = lfs::extract(&marked, f.len(), 42);
        println!("extracted {} bytes, errors {}", rec.len(), lfs::bit_errors(&f, &rec));
    }

}
