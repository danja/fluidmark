//! wasm/src/dsp.rs
//!
//! Signal processing over sample slices. Nothing here is exported; the ABI in the parent
//! module is the only way in.

/// Power at one frequency, by the Goertzel algorithm.
///
/// The same recurrence as `reference/WebBeep`'s `Goertzel.getPower`, so the two can be
/// compared sample for sample:
/// `s = x[n] + coeff*s_prev - s_prev2`, then
/// `power = s_prev2^2 + s_prev^2 - coeff*s_prev*s_prev2`.
///
/// Returns 0.0 for an empty slice rather than panicking, because the caller has already
/// refused a zero length and reaching here with one would be a bug worth hiding rather than
/// propagating.
pub fn goertzel_power(samples: &[f32], target_hz: f64, sample_rate: f64) -> f64 {
    if samples.is_empty() || sample_rate <= 0.0 || target_hz <= 0.0 || target_hz >= sample_rate {
        return 0.0;
    }
    let coeff = 2.0 * (2.0 * std::f64::consts::PI * target_hz / sample_rate).cos();
    let (mut s_prev, mut s_prev2) = (0.0f64, 0.0f64);
    for &x in samples {
        let s = x as f64 + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }
    s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
}

#[cfg(test)]
mod tests {
    use super::goertzel_power;

    const RATE: f64 = 44_100.0;

    fn sine(hz: f64, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| (0.5 * (2.0 * std::f64::consts::PI * hz * i as f64 / RATE).sin()) as f32)
            .collect()

    }

    #[test]
    fn finds_the_frequency_that_is_there() {
        let s = sine(440.0, 4410);
        let at = goertzel_power(&s, 440.0, RATE);
        let off = goertzel_power(&s, 1000.0, RATE);
        assert!(at > 0.0, "power at the tone's own frequency should be positive");
        assert!(at > off * 100.0, "440 Hz gave {at}, 1000 Hz gave {off}");
    }

    #[test]
    fn empty_slice_is_zero_not_a_panic() {
        assert_eq!(goertzel_power(&[], 440.0, RATE), 0.0);
    }

    #[test]
    fn a_frequency_above_the_sample_rate_is_zero() {
        let s = sine(440.0, 1024);
        assert_eq!(goertzel_power(&s, 50_000.0, RATE), 0.0);
    }

    #[test]
    fn a_zero_sample_rate_is_zero() {
        let s = sine(440.0, 1024);
        assert_eq!(goertzel_power(&s, 440.0, 0.0), 0.0);
    }
}