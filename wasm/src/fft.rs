//! wasm/src/fft.rs
//!
//! An in-place radix-2 complex FFT. Only what the spread-spectrum detector needs: a power-of-two
//! length, `f64`, no allocation per call.

use std::f64::consts::PI;

/// Transform `re`/`im` in place. `inverse` also divides by the length, so a forward transform
/// followed by an inverse returns the input.
///
/// Panics if the length is not a power of two or the slices differ. Callers inside the core size
/// them from a constant, so a panic here is a bug in the core rather than bad input.
pub fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    assert!(n.is_power_of_two() && im.len() == n, "fft needs a power-of-two length");

    // Bit-reversal permutation.
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let mut len = 2;
    while len <= n {
        let angle = 2.0 * PI / len as f64 * if inverse { 1.0 } else { -1.0 };
        let (wr, wi) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }

    if inverse {
        let scale = 1.0 / n as f64;
        for i in 0..n {
            re[i] *= scale;
            im[i] *= scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pure_cosine_lands_in_one_bin_and_its_mirror() {
        let n = 64;
        let mut re: Vec<f64> = (0..n).map(|i| (2.0 * PI * 5.0 * i as f64 / n as f64).cos()).collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im, false);
        for k in 0..n {
            let mag = (re[k] * re[k] + im[k] * im[k]).sqrt();
            if k == 5 || k == n - 5 {
                assert!((mag - n as f64 / 2.0).abs() < 1e-9, "bin {k} was {mag}");
            } else {
                assert!(mag < 1e-9, "bin {k} should be empty, was {mag}");
            }
        }
    }

    #[test]
    fn forward_then_inverse_returns_the_input() {
        let n = 256;
        let original: Vec<f64> = (0..n).map(|i| ((i * 37 + 11) % 101) as f64 - 50.0).collect();
        let mut re = original.clone();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im, false);
        fft(&mut re, &mut im, true);
        for i in 0..n {
            assert!((re[i] - original[i]).abs() < 1e-9);
            assert!(im[i].abs() < 1e-9);
        }
    }

    #[test]
    fn a_length_that_is_not_a_power_of_two_is_refused() {
        let result = std::panic::catch_unwind(|| {
            let mut re = vec![0.0; 12];
            let mut im = vec![0.0; 12];
            fft(&mut re, &mut im, false);
        });
        assert!(result.is_err());
    }
}
