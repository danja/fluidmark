//! wasm/src/estimate.rs
//!
//! The attack on the spread-spectrum mark that needs no key: estimate the carrier from the audio
//! itself and subtract it.
//!
//! The carrier is one waveform, repeated every `CHIPS` samples, multiplied by +1 or -1. Anyone who
//! knows that, and the scheme is published, can line the file up on a period, stack the blocks
//! with the signs that make them agree, and read the carrier off the stack: the music is different
//! in every block and averages away, and the mark is the same in every one. The key stops a reader
//! recovering the payload. It does not stop this, which needs none of it, and it is the reason the
//! documentation says the key protects the payload from being read and nothing from being removed.
//!
//! This exists to measure how well that works, so that "resists removal" is a figure and not a
//! hope. It is not a tool for use on anyone's marks.
//!
//! The alignment and the signs are found in the whitened domain, where the mark stands out of the
//! music. The carrier itself is then estimated in the music's own domain, from the blocks with
//! those signs and each divided by its own level, so a loud passage does not outvote a quiet one,
//! and subtracted there, at the level the mark follows the music, which the published scheme
//! states. An earlier version subtracted in the whitened domain and resynthesised through the
//! inverse of the whitening filter, and that filter has so much gain at the bass that a trace of
//! leakage came back as damage to the music several times the size of the mark.

use crate::spread::{band_limit, fir, whitening_filter, CHIPS};

/// Blocks used to find where a period begins. The mark is strongest and the music most varied
/// across consecutive blocks, so a modest run is enough.
const ALIGN_BLOCKS: usize = 64;

/// Blocks stacked to estimate the carrier.
const STACK_BLOCKS: usize = 1024;

/// Passes of estimate and subtract. One. Further passes were tried, on the reasoning that what a pass
/// leaves is the error in its estimate and has the same structure, and they made it worse: the signs are
/// fitted to the same blocks the carrier is then estimated from, so each pass takes out more of the
/// music along the fitted direction than of the mark, and the file ended 5 to 8 dB below itself for a
/// mark 23 dB below it. A careful attacker would hold some blocks out. This one does not, and what it
/// measures is a floor on what removal can do, not a ceiling.
const PASSES: usize = 1;

fn dot(a: &[f32], b: &[f32]) -> f64 {
    a.iter().zip(b).map(|(&x, &y)| x as f64 * y as f64).sum()
}

/// Remove the repeated carrier from `samples`, with no knowledge of the key.
///
/// Returns the input unchanged when it is too short to estimate anything from.
pub fn estimate_and_subtract(samples: &[f32]) -> Vec<f32> {
    // The alignment and the signs are found once, on the marked audio, where the mark is strongest. They
    // stay right as the mark is taken out; the carrier and its level are what each pass improves.
    let Some(found) = analyse(samples) else {
        return samples.to_vec();
    };
    let mut current = samples.to_vec();
    for _ in 0..PASSES {
        current = subtract(&current, &found);
    }
    current
}

/// What the attacker learns from the audio alone.
pub struct Estimate {
    /// The whitening filter, `1 + a1 z^-1 + ...`.
    pub whitener: Vec<f64>,
    /// Where a period begins, in samples.
    pub origin: usize,
    /// The carrier as it appears whitened, one period, unit length, aligned at `origin`.
    pub carrier: Vec<f64>,
    /// +1 or -1 for each block from `origin`: the bit the mark carries there.
    pub signs: Vec<f64>,
}

/// Place the period, estimate the carrier and read the signs. `None` when there is too little to go on.
pub fn analyse(samples: &[f32]) -> Option<Estimate> {
    let n = CHIPS;
    if samples.len() < (ALIGN_BLOCKS + 8) * n {
        return None;
    }
    let a = whitening_filter(samples)?;
    let z = fir(samples, &a);
    let zb = band_limit(&z);

    // Where a period begins: the offset at which consecutive blocks are most alike, up to sign,
    // taken over a run from the middle of the file.
    let run_start = (zb.len() / 2).saturating_sub(ALIGN_BLOCKS * n / 2);
    let normalised = |x: &[f32], y: &[f32]| {
        let (nx, ny) = (dot(x, x).sqrt(), dot(y, y).sqrt());
        if nx < 1e-9 || ny < 1e-9 { 0.0 } else { dot(x, y) / (nx * ny) }
    };
    let score_at = |phi: usize| -> f64 {
        (0..ALIGN_BLOCKS - 1)
            .map(|k| {
                let s = run_start + phi + k * n;
                normalised(&zb[s..s + n], &zb[s + n..s + 2 * n]).powi(2)
            })
            .sum()
    };
    // Two samples at a time is enough: the carrier is band-limited to 8 kHz, so it is smooth over
    // about three samples, and the last step is refined below.
    let coarse = (0..n)
        .step_by(2)
        .filter(|&phi| run_start + phi + ALIGN_BLOCKS * n <= zb.len())
        .max_by(|&p, &q| score_at(p).partial_cmp(&score_at(q)).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(0);
    let phi = (coarse.saturating_sub(1)..=coarse + 1)
        .filter(|&p| run_start + p + ALIGN_BLOCKS * n <= zb.len())
        .max_by(|&p, &q| score_at(p).partial_cmp(&score_at(q)).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(coarse);
    let origin = (run_start + phi) % n;

    // Stack blocks with the signs that make them agree, a few times over, starting from one block.
    let blocks = (zb.len() - origin) / n;
    let used = blocks.min(STACK_BLOCKS);
    let first = (blocks - used) / 2;
    let block = |j: usize| &zb[origin + j * n..origin + (j + 1) * n];
    let mut carrier: Vec<f64> = block(first).iter().map(|&v| v as f64).collect();
    for _ in 0..8 {
        let mut next = vec![0.0f64; n];
        for j in first..first + used {
            let b = block(j);
            let sign = carrier.iter().zip(b).map(|(&c, &v)| c * v as f64).sum::<f64>().signum();
            for (slot, &v) in next.iter_mut().zip(b) {
                *slot += sign * v as f64;
            }
        }
        let norm = next.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm < 1e-12 {
            return None;
        }
        carrier = next.iter().map(|v| v / norm).collect();
    }
    let signs = (0..blocks)
        .map(|j| carrier.iter().zip(block(j)).map(|(&c, &v)| c * v as f64).sum::<f64>().signum())
        .collect();
    Some(Estimate { whitener: a, origin, carrier, signs })
}

/// Subtract the estimated mark from the audio.
///
/// The carrier is estimated again in the music's own band-limited domain from the blocks, with the
/// signs found above and each block divided by its own level. Each block's share of it is then the
/// mark's level there, which is a fixed fraction of the block's own level, since that is how the
/// scheme sets it, so the fraction is estimated once, from all the blocks together, and not once per
/// block, where the music itself would be most of the noise.
pub fn subtract(samples: &[f32], found: &Estimate) -> Vec<f32> {
    let n = CHIPS;
    let band = band_limit(samples);
    let origin = found.origin;
    let blocks = found.signs.len();
    let block = |j: usize| &band[origin + j * n..origin + (j + 1) * n];
    let level = |j: usize| (dot(block(j), block(j)) / n as f64).sqrt();

    // The carrier, in this domain: the signed mean of the blocks, each at unit level.
    let mut carrier = vec![0.0f64; n];
    let mut counted = 0usize;
    for j in 0..blocks.min(STACK_BLOCKS * 2) {
        let l = level(j);
        if l < 1e-9 {
            continue;
        }
        for (slot, &v) in carrier.iter_mut().zip(block(j)) {
            *slot += found.signs[j] * v as f64 / l;
        }
        counted += 1;
    }
    if counted == 0 {
        return samples.to_vec();
    }
    let norm = (carrier.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
    if norm < 1e-12 {
        return samples.to_vec();
    }
    // Unit RMS, so that a block's share of it is directly a fraction of the block's own level.
    for v in carrier.iter_mut() {
        *v /= norm;
    }

    // The share of each block that lies along the carrier, as a fraction of the block's level, and
    // the typical fraction: the mark's level relative to the music.
    let share = |j: usize| -> Option<f64> {
        let l = level(j);
        if l < 1e-9 {
            return None;
        }
        let along: f64 = carrier.iter().zip(block(j)).map(|(&c, &v)| c * v as f64).sum::<f64>() / n as f64;
        Some(found.signs[j] * along / l)
    };
    let mut shares: Vec<f64> = (0..blocks).filter_map(share).collect();
    if shares.is_empty() {
        return samples.to_vec();
    }
    shares.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let typical = shares[shares.len() / 2];
    if typical <= 0.0 {
        return samples.to_vec();
    }

    let mut out = samples.to_vec();
    for j in 0..blocks {
        let amount = found.signs[j] * typical * level(j);
        for (i, &c) in carrier.iter().enumerate() {
            out[origin + j * n + i] -= (amount * c) as f32;
        }
    }
    out
}
