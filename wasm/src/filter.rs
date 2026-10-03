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

/// One second-order section run a sample at a time, with the same arithmetic as `run_section`, so a
/// signal filtered streaming and the same signal filtered whole agree exactly. The embedder needs
/// the band-limited host to measure its level and does not need to keep it, and holding a whole
/// channel's worth of it was most of what made marking a long track expensive.
#[derive(Clone, Copy)]
pub struct Biquad {
    k: [f32; 5],
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn new(k: [f32; 5]) -> Self {
        Biquad { k, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let [b0, b1, b2, a1, a2] = self.k;
        let y = b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// `highpass` then `lowpass`, streaming: the same four sections in the same order.
pub struct BandPass {
    sections: [Biquad; 4],
}

impl BandPass {
    pub fn new(low_cut: f32, high_cut: f32, sample_rate: f32) -> Self {
        let hp = Biquad::new(section(low_cut, sample_rate, true));
        let lp = Biquad::new(section(high_cut, sample_rate, false));
        BandPass { sections: [hp, hp, lp, lp] }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let mut v = x;
        for section in &mut self.sections {
            v = section.process(v);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_the_band_filter_matches_filtering_the_whole_signal_exactly() {
        let signal: Vec<f32> = (0..20_000)
            .map(|i| ((i * 7919 % 1000) as f32 / 500.0 - 1.0) * (i as f32 * 0.01).sin())
            .collect();
        let whole = lowpass(&highpass(&signal, 250.0, 44_100.0), 8000.0, 44_100.0);
        let mut band = BandPass::new(250.0, 8000.0, 44_100.0);
        let streamed: Vec<f32> = signal.iter().map(|&x| band.process(x)).collect();
        assert_eq!(whole, streamed, "not a single sample may differ");
    }
}
