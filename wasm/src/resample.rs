//! wasm/src/resample.rs
//!
//! A windowed-sinc resampler, for the detector to bring audio back to the rate the mark is
//! defined at.
//!
//! Separate from `attack::resample`, which is deliberately a cheap linear interpolator: it is
//! standing in for what a careless transcoder does to a track. The detector should not be that
//! careless, because every dB it loses to its own interpolation is a dB the mark has to make up.

use std::f64::consts::PI;

/// Half-width of the kernel in input samples. 16 zero crossings each side is plenty for a
/// band that stops well below Nyquist.
const HALF_WIDTH: isize = 16;

/// Table resolution for the kernel, per half-width.
const KERNEL_STEPS: usize = 4096;

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

/// Resample `samples` from `from_rate` to `to_rate`.
///
/// The output length is `round(len * to / from)`. When downsampling, the kernel is stretched so
/// it band-limits to the new Nyquist as it interpolates, rather than aliasing.
pub fn resample(samples: &[f32], from_rate: f64, to_rate: f64) -> Vec<f32> {
    if samples.is_empty() || !(from_rate > 0.0) || !(to_rate > 0.0) {
        return Vec::new();
    }
    if (from_rate - to_rate).abs() < 1e-9 {
        return samples.to_vec();
    }
    let ratio = to_rate / from_rate;
    let out_len = (samples.len() as f64 * ratio).round().max(1.0) as usize;
    // Cutoff as a fraction of the input rate, with a little margin under the new Nyquist.
    let cutoff = ratio.min(1.0) * 0.95;
    let stretch = 1.0 / ratio.min(1.0);
    let reach = (HALF_WIDTH as f64 * stretch).ceil() as isize;

    // The kernel is the same shape for every output sample, so it is tabulated once and
    // interpolated. Computing a sine and a cosine per tap per sample made a three-minute track
    // take seconds, and the detector resamples every file that is not already at 44.1 kHz.
    let reach_f = reach as f64;
    let kernel: Vec<f64> = (0..=KERNEL_STEPS)
        .map(|i| {
            let u = i as f64 / KERNEL_STEPS as f64;
            cutoff * sinc(cutoff * u * reach_f) * 0.5 * (1.0 + (PI * u).cos())
        })
        .collect();

    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f64 / ratio;
        let centre = position.floor() as isize;
        let mut acc = 0.0f64;
        for k in (centre - reach + 1)..=(centre + reach) {
            if k < 0 || k as usize >= samples.len() {
                continue;
            }
            let u = (position - k as f64).abs() / reach_f;
            if u >= 1.0 {
                continue;
            }
            let at = u * KERNEL_STEPS as f64;
            let lo = at as usize;
            let t = at - lo as f64;
            acc += samples[k as usize] as f64 * (kernel[lo] * (1.0 - t) + kernel[lo + 1] * t);
        }
        out.push(acc as f32);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f64, rate: f64, len: usize) -> Vec<f32> {
        (0..len).map(|i| (2.0 * PI * hz * i as f64 / rate).sin() as f32).collect()
    }

    #[test]
    fn the_length_follows_the_ratio() {
        assert_eq!(resample(&vec![0.0; 44_100], 44_100.0, 48_000.0).len(), 48_000);
        assert_eq!(resample(&vec![0.0; 48_000], 48_000.0, 44_100.0).len(), 44_100);
    }

    #[test]
    fn a_tone_keeps_its_frequency_and_level() {
        let up = resample(&tone(1000.0, 44_100.0, 44_100), 44_100.0, 48_000.0);
        let expected = tone(1000.0, 48_000.0, 48_000);
        let (mut err, mut norm) = (0.0f64, 0.0f64);
        for i in 200..47_800 {
            err += ((up[i] - expected[i]) as f64).powi(2);
            norm += (expected[i] as f64).powi(2);
        }
        assert!(err / norm < 1e-4, "relative error {}", err / norm);
    }

    #[test]
    fn up_then_down_returns_close_to_the_input_inside_the_band() {
        let input = tone(3000.0, 44_100.0, 20_000);
        let back = resample(&resample(&input, 44_100.0, 48_000.0), 48_000.0, 44_100.0);
        let n = input.len().min(back.len());
        let (mut err, mut norm) = (0.0f64, 0.0f64);
        for i in 300..n - 300 {
            err += ((back[i] - input[i]) as f64).powi(2);
            norm += (input[i] as f64).powi(2);
        }
        assert!(err / norm < 1e-3, "relative error {}", err / norm);
    }

    #[test]
    fn a_tone_above_the_new_nyquist_is_removed_not_aliased() {
        let out = resample(&tone(20_000.0, 44_100.0, 44_100), 44_100.0, 22_050.0);
        let peak = out[100..out.len() - 100].iter().fold(0.0f32, |a, &x| a.max(x.abs()));
        assert!(peak < 0.05, "peak {peak}");
    }

    #[test]
    fn nonsense_rates_give_nothing() {
        assert!(resample(&[1.0], 0.0, 44_100.0).is_empty());
        assert!(resample(&[], 44_100.0, 48_000.0).is_empty());
    }
}
