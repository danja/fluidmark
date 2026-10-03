//! wasm/src/filter.rs
//!
//! Second-order filter sections and the cascades built from them.
//!
//! Shared by the attack harness, which low- and high-passes audio to damage it, and the
//! spread-spectrum scheme, which uses the same cascades to band-limit its carrier. Two copies of
//! a filter would be two sets of coefficients that could drift apart.

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
