//! wasm/src/spread.rs
//!
//! Direct-sequence spread spectrum: the first scheme that is meant to survive the attack list.
//!
//! Each channel bit is a keyed band-limited noise carrier, `CHIPS` samples long, multiplied by
//! +1 or -1 and added to the host at a level that follows the host's own in-band level. The
//! carrier is white inside a band and the same waveform for every bit, so the mark reads as
//! faint noise and nothing in the file marks where a bit begins. Without the key there is no
//! carrier to correlate against; with it the reader gets `sqrt(CHIPS)` of processing gain on
//! every bit.
//!
//! The stream, repeated end to end for as long as the track lasts:
//!
//! ```text
//! [ sync: 32 keyed bits ][ header: 10 bytes, Hamming, interleaved ][ body: n bytes, same ]
//! ```
//!
//! The header and body are the frame from `frame.rs`, so the magic number, the length and the
//! CRC-16 are what decide whether anything was found. The sync word is how the reader finds the
//! start of a copy, and the repeats are soft-combined once it has, which is where most of the
//! robustness comes from: a track is much longer than one copy.
//!
//! The reader has to find three things blind. **The bit boundary** is found with a circular
//! cross-correlation of the whole file folded onto one carrier period, summed over many blocks.
//! A crop or a time shift moves the boundary and this finds it again. **The rate** is handled
//! by resampling to 44.1 kHz first, so a resampled file reads like the original. **The copy
//! boundary** is found from the sync word, in bits.
//!
//! Before correlating, the received audio is whitened with a linear-predictive filter fitted to
//! the file itself. Music is nothing like white, and a matched filter is only matched against
//! white noise; whitening is what keeps a loud bass line from being the loudest thing the
//! correlator sees.
//!
//! What this is not: it is not psychoacoustic. The level follows the host's energy in the band,
//! which is a proxy for masking and not a model of it, and SNR is not audibility. The strength is
//! a parameter, and whether any value of it is inaudible is a listening question that nothing in
//! this file answers. See `docs/steganography.md`.

use crate::ecc;
use crate::fft::fft;
use crate::filter::{highpass, lowpass};
use crate::frame::{self, FrameError, HEADER_BYTES};
use crate::lfs::splitmix64;
use crate::resample;

/// The rate the mark is defined at. Audio at any other rate is resampled to this to be read, and
/// the carrier is resampled from it to be written.
pub const RATE: f64 = 44_100.0;

/// Samples per channel bit, and the carrier's period.
pub const CHIPS: usize = 2048;

/// The band the carrier occupies, in Hz at `RATE`. Wide enough to carry processing gain, and
/// clear of the bottom where the host is loudest and the top that a lossy codec removes first.
pub const BAND_LO: f32 = 250.0;
pub const BAND_HI: f32 = 8000.0;

/// Keyed bits that open every copy.
pub const SYNC_BITS: usize = 32;

/// Order of the whitening filter.
const LPC_ORDER: usize = 16;

/// Samples of input the reader will look at, before resampling. Bounds the work on a file it was
/// handed by someone else: about three minutes at 44.1 kHz, which holds many copies.
pub const MAX_ANALYSIS: usize = 1 << 23;

/// Blocks used to find the bit boundary. Spread evenly over the file.
const LAG_BLOCKS: usize = 512;

/// How far the boundary peak has to stand above the rest, in standard deviations.
const LAG_SIGMAS: f64 = 6.0;

/// How far a sync peak has to stand above the rest of the scores, in robust standard deviations.
const SYNC_SIGMAS: f64 = 5.0;

/// Sync candidates the reader will try, strongest first.
const MAX_CANDIDATES: usize = 8;

/// The embedding level relative to the host's level in the band, in dB.
pub const DEFAULT_STRENGTH_DB: f64 = -20.0;

/// Smoothing blocks for the host-level estimate.
const ENV_BLOCK: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpreadError {
    /// The frame is shorter than a header.
    BadFrame,
    /// The audio cannot hold one copy of the stream.
    TooShort,
    /// The sample rate is not usable.
    BadRate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// The frame was found and its checksum matched.
    Verified,
    /// Nothing recognisable was found.
    NoMark,
    /// A frame header was found and the checksum did not match: a mark, damaged.
    Damaged,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub status: Status,
    /// The frame bytes as read, header included. Empty unless a header was found. Not to be
    /// believed unless `status` is `Verified`; the harness wants them to count bit errors.
    pub frame: Vec<u8>,
    /// How far the sync peak stood above the noise, in standard deviations. 0 when none was found.
    pub sync_sigmas: f64,
    /// How many whole copies of the stream were combined.
    pub copies: usize,
}

impl Detection {
    fn none() -> Self {
        Detection { status: Status::NoMark, frame: Vec::new(), sync_sigmas: 0.0, copies: 0 }
    }
}

// Sub-keys. Distinct constants so one key does not give the carrier, the sync word and the two
// interleavers the same sequence.
const K_CARRIER: u64 = 0x6a09_e667_f3bc_c908;
const K_SYNC: u64 = 0xbb67_ae85_84ca_a73b;
const K_HEADER: u64 = 0x3c6e_f372_fe94_f82b;
const K_BODY: u64 = 0xa54f_f53a_5f1d_36f1;

/// Bits in one copy of the stream for a frame of `frame_bytes`.
pub fn copy_bits(frame_bytes: usize) -> usize {
    SYNC_BITS + ecc::BITS_PER_BYTE * frame_bytes
}

/// Samples at the mark's own rate that one copy occupies.
pub fn copy_samples(frame_bytes: usize) -> usize {
    copy_bits(frame_bytes) * CHIPS
}

fn band_limit(samples: &[f32]) -> Vec<f32> {
    lowpass(&highpass(samples, BAND_LO, RATE as f32), BAND_HI, RATE as f32)
}

/// One period of the carrier: keyed chips, band-limited, zero mean, unit RMS.
///
/// Filtered over several periods and the last kept, so the period is the filter's steady state
/// rather than its start-up transient and joins cleanly to itself.
fn carrier(key: u64) -> Vec<f32> {
    let mut state = key ^ K_CARRIER;
    let chips: Vec<f32> = (0..CHIPS)
        .map(|_| if splitmix64(&mut state) & 1 == 1 { 1.0 } else { -1.0 })
        .collect();
    let repeated: Vec<f32> = chips.iter().cycle().take(CHIPS * 4).copied().collect();
    let filtered = band_limit(&repeated);
    let mut period: Vec<f32> = filtered[CHIPS * 3..].to_vec();
    let mean = period.iter().sum::<f32>() / CHIPS as f32;
    period.iter_mut().for_each(|x| *x -= mean);
    let rms = (period.iter().map(|x| x * x).sum::<f32>() / CHIPS as f32).sqrt();
    period.iter_mut().for_each(|x| *x /= rms);
    period
}

fn sync_word(key: u64) -> Vec<f32> {
    let mut state = key ^ K_SYNC;
    (0..SYNC_BITS)
        .map(|_| if splitmix64(&mut state) & 1 == 1 { 1.0 } else { -1.0 })
        .collect()
}

/// One copy of the stream as +1/-1 values.
fn stream(frame: &[u8], key: u64) -> Vec<f32> {
    let header = ecc::interleave(&ecc::encode(&frame[..HEADER_BYTES]), key ^ K_HEADER);
    let body = ecc::interleave(&ecc::encode(&frame[HEADER_BYTES..]), key ^ K_BODY);
    let mut bits = sync_word(key);
    bits.extend(header.iter().chain(body.iter()).map(|&b| if b == 1 { 1.0 } else { -1.0 }));
    bits
}

/// The host's level in the carrier's band, per sample.
///
/// Block RMS, smoothed over three blocks, interpolated linearly between block centres so the
/// mark's level changes smoothly rather than in steps, which would be audible as a click train.
fn host_level(samples: &[f32], sample_rate: f32) -> Vec<f32> {
    let band = lowpass(&highpass(samples, BAND_LO, sample_rate), BAND_HI, sample_rate);
    let blocks = samples.len().div_ceil(ENV_BLOCK);
    let power: Vec<f32> = (0..blocks)
        .map(|b| {
            let chunk = &band[b * ENV_BLOCK..((b + 1) * ENV_BLOCK).min(band.len())];
            chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len() as f32
        })
        .collect();
    let level: Vec<f32> = (0..blocks)
        .map(|b| {
            let lo = b.saturating_sub(1);
            let hi = (b + 1).min(blocks - 1);
            let span = &power[lo..=hi];
            (span.iter().sum::<f32>() / span.len() as f32).sqrt()
        })
        .collect();
    (0..samples.len())
        .map(|i| {
            let at = (i as f32 - ENV_BLOCK as f32 / 2.0) / ENV_BLOCK as f32;
            let b0 = at.floor().max(0.0) as usize;
            let b1 = (b0 + 1).min(blocks - 1);
            let t = (at - b0 as f32).clamp(0.0, 1.0);
            level[b0.min(blocks - 1)] * (1.0 - t) + level[b1] * t
        })
        .collect()
}

/// Add the mark to `samples`, returning the marked copy.
///
/// `frame` is a whole frame from `frame::encode`. `strength_db` is the mark's level relative to
/// the host's level in the band, so -20 means a mark whose RMS is a tenth of the host's in that
/// band. Whether that is audible is not something this function knows.
pub fn embed(
    samples: &[f32],
    frame_bytes: &[u8],
    key: u64,
    sample_rate: f64,
    strength_db: f64,
) -> Result<Vec<f32>, SpreadError> {
    if !(sample_rate >= 8000.0 && sample_rate <= 192_000.0) || !strength_db.is_finite() {
        return Err(SpreadError::BadRate);
    }
    if frame_bytes.len() < HEADER_BYTES {
        return Err(SpreadError::BadFrame);
    }
    let bits = stream(frame_bytes, key);
    let n44 = ((samples.len() as f64) * RATE / sample_rate).ceil() as usize;
    if n44 < bits.len() * CHIPS {
        return Err(SpreadError::TooShort);
    }

    let period = carrier(key);
    let at_mark_rate: Vec<f32> = (0..n44)
        .map(|i| bits[(i / CHIPS) % bits.len()] * period[i % CHIPS])
        .collect();
    let mut wave = resample::resample(&at_mark_rate, RATE, sample_rate);
    wave.resize(samples.len(), 0.0);

    let level = host_level(samples, sample_rate as f32);
    let gain = 10f32.powf(strength_db as f32 / 20.0);
    Ok(samples
        .iter()
        .zip(wave.iter().zip(level.iter()))
        .map(|(&x, (&w, &l))| x + gain * l * w)
        .collect())
}

/// Coefficients of a prediction-error filter `1 + a1 z^-1 + ... + ap z^-p`, fitted to `samples`
/// by Levinson-Durbin, or `None` for a signal with no energy to fit.
fn whitening_filter(samples: &[f32]) -> Option<Vec<f64>> {
    let fit = &samples[..samples.len().min(1 << 21)];
    let mut r = [0.0f64; LPC_ORDER + 1];
    for (lag, slot) in r.iter_mut().enumerate() {
        *slot = fit
            .iter()
            .zip(fit.iter().skip(lag))
            .map(|(&a, &b)| a as f64 * b as f64)
            .sum();
    }
    if !(r[0] > 1e-9) {
        return None;
    }
    // A touch of white noise on the diagonal keeps the recursion stable on a nearly pure tone.
    r[0] *= 1.0 + 1e-4;

    let mut a = vec![0.0f64; LPC_ORDER + 1];
    a[0] = 1.0;
    let mut error = r[0];
    for i in 1..=LPC_ORDER {
        let acc: f64 = r[i] + (1..i).map(|j| a[j] * r[i - j]).sum::<f64>();
        let k = -acc / error;
        let previous = a.clone();
        for j in 1..i {
            a[j] = previous[j] + k * previous[i - j];
        }
        a[i] = k;
        error *= 1.0 - k * k;
        if !(error > 0.0) {
            return None;
        }
    }
    Some(a)
}

fn fir(samples: &[f32], a: &[f64]) -> Vec<f32> {
    (0..samples.len())
        .map(|n| {
            let mut acc = 0.0f64;
            for (k, &c) in a.iter().enumerate() {
                if n >= k {
                    acc += c * samples[n - k] as f64;
                }
            }
            acc as f32
        })
        .collect()
}

/// What the carrier looks like after the reader's own filtering, so the correlator is matched to
/// what the mark has become rather than to what was written.
fn expected_carrier(key: u64, a: &[f64]) -> Vec<f32> {
    let repeated: Vec<f32> = carrier(key).iter().cycle().take(CHIPS * 4).copied().collect();
    let filtered = band_limit(&fir(&repeated, a));
    filtered[CHIPS * 3..].to_vec()
}

/// Where in each carrier period a bit begins, found by folding the file onto one period.
///
/// For each block the circular cross-correlation with the carrier peaks at the bit boundary's
/// offset. Whether a block holds a +1 or a -1 flips the peak's sign, so the squares are summed,
/// and a boundary that falls inside a block only weakens its peak. Returns the offset and how
/// many standard deviations the peak stood above the other offsets.
fn find_boundary(y: &[f32], reference: &[f32]) -> Option<(usize, f64)> {
    let total_blocks = y.len() / CHIPS;
    if total_blocks < 8 {
        return None;
    }
    let stride = (total_blocks / LAG_BLOCKS).max(1);

    let mut cr: Vec<f64> = reference.iter().map(|&x| x as f64).collect();
    let mut ci = vec![0.0f64; CHIPS];
    fft(&mut cr, &mut ci, false);
    let ref_norm = reference.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();

    let mut energy = vec![0.0f64; CHIPS];
    let mut used = 0usize;
    let mut block = 0usize;
    while block < total_blocks && used < LAG_BLOCKS {
        let chunk = &y[block * CHIPS..(block + 1) * CHIPS];
        block += stride;
        let norm = chunk.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        if norm < 1e-9 {
            continue;
        }
        let mut re: Vec<f64> = chunk.iter().map(|&x| x as f64).collect();
        let mut im = vec![0.0f64; CHIPS];
        fft(&mut re, &mut im, false);
        // Y times conj(C): the circular cross-correlation in the frequency domain.
        for k in 0..CHIPS {
            let (a, b) = (re[k], im[k]);
            re[k] = a * cr[k] + b * ci[k];
            im[k] = b * cr[k] - a * ci[k];
        }
        fft(&mut re, &mut im, true);
        let scale = 1.0 / (norm * ref_norm);
        for k in 0..CHIPS {
            energy[k] += (re[k] * scale).powi(2);
        }
        used += 1;
    }
    if used < 4 {
        return None;
    }

    let (peak, &best) = energy
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    // The rest of the offsets, leaving out the peak and its neighbours, which a band-limited
    // carrier smears across a few samples.
    let rest: Vec<f64> = (0..CHIPS)
        .filter(|&k| {
            let d = (k + CHIPS - peak) % CHIPS;
            d > 4 && d < CHIPS - 4
        })
        .map(|k| energy[k])
        .collect();
    let mean = rest.iter().sum::<f64>() / rest.len() as f64;
    let var = rest.iter().map(|e| (e - mean).powi(2)).sum::<f64>() / rest.len() as f64;
    let sigma = var.sqrt().max(1e-30);
    let sigmas = (best - mean) / sigma;
    if sigmas < LAG_SIGMAS {
        return None;
    }
    Some((peak, sigmas))
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// Read the stream's header and body out of combined soft values laid out as one copy.
fn read_copy(soft: &[f32], key: u64) -> (Vec<u8>, usize) {
    let header_bits = ecc::BITS_PER_BYTE * HEADER_BYTES;
    let header = ecc::decode(&ecc::deinterleave(&soft[SYNC_BITS..SYNC_BITS + header_bits], key ^ K_HEADER));
    let length = if header.len() == HEADER_BYTES { u16::from_le_bytes([header[6], header[7]]) as usize } else { 0 };
    (header, length)
}

fn header_is_plausible(header: &[u8]) -> bool {
    header.len() == HEADER_BYTES && header[0..4] == frame::MAGIC && header[4] == frame::VERSION
}

/// Look for a mark in `samples`, recorded at `sample_rate`.
///
/// Never trusts what it reads: a result is `Verified` only when the frame's magic, version,
/// length and CRC-16 all agree, and everything short of that is `Damaged` or `NoMark`.
pub fn detect(samples: &[f32], sample_rate: f64, key: u64) -> Result<Detection, SpreadError> {
    if !(sample_rate >= 8000.0 && sample_rate <= 192_000.0) {
        return Err(SpreadError::BadRate);
    }
    let bounded = &samples[..samples.len().min(MAX_ANALYSIS)];
    let at_rate = resample::resample(bounded, sample_rate, RATE);
    if at_rate.len() < 8 * CHIPS {
        return Ok(Detection::none());
    }

    let Some(a) = whitening_filter(&at_rate) else {
        return Ok(Detection::none());
    };
    let y = band_limit(&fir(&at_rate, &a));
    let reference = expected_carrier(key, &a);

    let Some((boundary, _)) = find_boundary(&y, &reference) else {
        return Ok(Detection::none());
    };

    // One soft value per bit: the correlation coefficient of the block with the carrier, scaled
    // by sqrt(CHIPS) so that noise reads as unit variance whatever the loudness.
    let ref_norm = reference.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
    let bits = (y.len() - boundary) / CHIPS;
    let mut soft = Vec::with_capacity(bits);
    for j in 0..bits {
        let chunk = &y[boundary + j * CHIPS..boundary + (j + 1) * CHIPS];
        let norm = chunk.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        if norm < 1e-9 {
            soft.push(0.0);
            continue;
        }
        let dot: f64 = chunk.iter().zip(&reference).map(|(&a, &b)| a as f64 * b as f64).sum();
        soft.push((dot / (norm * ref_norm) * (CHIPS as f64).sqrt()) as f32);
    }
    if soft.len() < SYNC_BITS + ecc::BITS_PER_BYTE * HEADER_BYTES {
        return Ok(Detection::none());
    }

    let sync = sync_word(key);
    let positions = soft.len() - SYNC_BITS + 1;
    let scores: Vec<f64> = (0..positions)
        .map(|j| sync.iter().zip(&soft[j..j + SYNC_BITS]).map(|(&s, &z)| (s * z) as f64).sum())
        .collect();
    let mut magnitudes: Vec<f64> = scores.iter().map(|s| s.abs()).collect();
    let sigma = 1.4826 * median(&mut magnitudes);
    if !(sigma > 0.0) {
        return Ok(Detection::none());
    }

    let mut order: Vec<usize> = (0..positions).collect();
    order.sort_by(|&p, &q| scores[q].abs().partial_cmp(&scores[p].abs()).unwrap_or(std::cmp::Ordering::Equal));
    let mut candidates: Vec<usize> = Vec::new();
    for &p in &order {
        if scores[p].abs() / sigma < SYNC_SIGMAS || candidates.len() >= MAX_CANDIDATES {
            break;
        }
        if candidates.iter().all(|&c| c.abs_diff(p) >= SYNC_BITS) {
            candidates.push(p);
        }
    }

    for &start in &candidates {
        let polarity = scores[start].signum() as f32;
        let header_bits = ecc::BITS_PER_BYTE * HEADER_BYTES;
        if start + SYNC_BITS + header_bits > soft.len() {
            continue;
        }
        let single: Vec<f32> = soft[start..start + SYNC_BITS + header_bits].iter().map(|&z| z * polarity).collect();
        let (header, length) = read_copy(&single, key);
        if !header_is_plausible(&header) {
            continue;
        }

        // The length is known, so the period of the repeats is: combine every whole copy.
        let period = copy_bits(HEADER_BYTES + length);
        let first = start % period;
        let mut combined = vec![0.0f32; period];
        let mut copies = 0usize;
        let mut at = first;
        while at + period <= soft.len() {
            for (slot, &z) in combined.iter_mut().zip(&soft[at..at + period]) {
                *slot += z * polarity;
            }
            copies += 1;
            at += period;
        }
        // `start` itself may fall in a copy that was cut short at the end of the file. Then the
        // header at `start` was read from a single copy and there is nothing to combine.
        if copies == 0 {
            continue;
        }
        // Rotate so the combined values begin at a sync word. `first` is where the first whole
        // copy begins, and `start` is a multiple of `period` past it, so it already does.
        let (header, length) = read_copy(&combined, key);
        if !header_is_plausible(&header) {
            continue;
        }
        let body_bits = ecc::BITS_PER_BYTE * length;
        let body_start = SYNC_BITS + header_bits;
        let body = ecc::decode(&ecc::deinterleave(&combined[body_start..body_start + body_bits], key ^ K_BODY));

        let mut frame_bytes = header;
        frame_bytes.extend_from_slice(&body);
        let status = match frame::decode(&frame_bytes) {
            Ok(_) => Status::Verified,
            Err(FrameError::NoMark) | Err(FrameError::TooShort) => continue,
            Err(_) => Status::Damaged,
        };
        return Ok(Detection {
            status,
            frame: frame_bytes,
            sync_sigmas: scores[start].abs() / sigma,
            copies,
        });
    }
    Ok(Detection::none())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attack;

    const KEY: u64 = 0x0123_4567_89ab_cdef;

    /// Something music-shaped: decaying harmonic notes on a changing chord, a noisy percussive
    /// hit on the beat, and a little broadband noise. Not music, but not a tone either, and
    /// a tone is the host that flatters every detector.
    fn music(seconds: f64, rate: f64, seed: u64) -> Vec<f32> {
        let n = (seconds * rate) as usize;
        let mut state = seed | 1;
        let notes = [110.0, 138.6, 164.8, 196.0, 220.0, 261.6, 329.6];
        (0..n)
            .map(|i| {
                let t = i as f64 / rate;
                let beat = (t * 2.0).floor() as usize;
                let phase = (t * 2.0).fract();
                let mut v = 0.0;
                for h in 0..3 {
                    let f = notes[(beat * 3 + h * 2) % notes.len()];
                    for harmonic in 1..=5 {
                        v += (0.25 / harmonic as f64)
                            * (-1.5 * phase).exp()
                            * (2.0 * std::f64::consts::PI * f * harmonic as f64 * t).sin();
                    }
                }
                let hit = (-18.0 * phase).exp();
                let noise = (splitmix64(&mut state) >> 40) as f64 / (1u64 << 24) as f64 - 0.5;
                (0.4 * v + 0.5 * hit * noise + 0.02 * noise) as f32
            })
            .collect()
    }

    fn payload() -> Vec<u8> {
        frame::encode(b"http://danbri.org/foaf", 0)
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    fn marked(seconds: f64) -> (Vec<f32>, Vec<f32>) {
        let host = music(seconds, RATE, 7);
        let out = embed(&host, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).expect("embeds");
        (host, out)
    }

    fn seconds_needed() -> f64 {
        copy_samples(payload().len()) as f64 / RATE
    }

    #[test]
    fn a_marked_track_reads_back_exactly() {
        let (_, out) = marked(seconds_needed() * 2.2);
        let found = detect(&out, RATE, KEY).unwrap();
        assert_eq!(found.status, Status::Verified, "{found:?}");
        assert_eq!(found.frame, payload());
        assert!(found.copies >= 2, "combined {} copies", found.copies);
    }

    #[test]
    fn the_mark_is_at_the_requested_level_below_the_host() {
        let (host, out) = marked(seconds_needed() * 1.1);
        let diff: Vec<f32> = out.iter().zip(&host).map(|(a, b)| a - b).collect();
        let band_host = band_limit(&host);
        let band_diff = band_limit(&diff);
        let db = 20.0 * (rms(&band_diff) / rms(&band_host)).log10();
        assert!((-24.0..=-15.0).contains(&db), "mark is {db:.1} dB below the host in band");
    }

    #[test]
    fn the_wrong_key_finds_nothing() {
        let (_, out) = marked(seconds_needed() * 1.5);
        let found = detect(&out, RATE, KEY ^ 1).unwrap();
        assert_ne!(found.status, Status::Verified);
    }

    #[test]
    fn unmarked_audio_is_never_reported_as_marked() {
        for seed in 1..=6 {
            let host = music(seconds_needed() * 1.5, RATE, seed);
            let found = detect(&host, RATE, KEY).unwrap();
            assert_eq!(found.status, Status::NoMark, "seed {seed}: {found:?}");
        }
        let mut state = 99u64;
        let noise: Vec<f32> = (0..(seconds_needed() * RATE) as usize)
            .map(|_| ((splitmix64(&mut state) >> 40) as f32 / (1u64 << 24) as f32) - 0.5)
            .collect();
        assert_eq!(detect(&noise, RATE, KEY).unwrap().status, Status::NoMark);
    }

    #[test]
    fn a_time_shift_and_a_crop_are_found_blind() {
        let (_, out) = marked(seconds_needed() * 2.5);
        let shifted = attack::time_shift(&out, 1000);
        assert_eq!(detect(&shifted, RATE, KEY).unwrap().status, Status::Verified, "shift");
        let drop = (out.len() as f64 * 0.05) as usize;
        let cropped = attack::crop(&out, drop, out.len());
        assert_eq!(detect(&cropped, RATE, KEY).unwrap().status, Status::Verified, "crop");
    }

    #[test]
    fn a_gain_change_is_survived() {
        let (_, out) = marked(seconds_needed() * 2.2);
        for db in [-6.0, 3.0] {
            let found = detect(&attack::gain(&out, db), RATE, KEY).unwrap();
            assert_eq!(found.status, Status::Verified, "{db} dB");
        }
    }

    #[test]
    fn resampling_to_another_rate_is_undone_by_the_reader() {
        let (_, out) = marked(seconds_needed() * 2.2);
        let up = attack::resample(&out, 48_000.0 / 44_100.0, RATE as f32);
        assert_eq!(detect(&up, 48_000.0, KEY).unwrap().status, Status::Verified, "48 kHz");
    }

    #[test]
    fn a_track_at_another_rate_can_be_marked_and_read() {
        let host = music(seconds_needed() * 2.2, 48_000.0, 3);
        let out = embed(&host, &payload(), KEY, 48_000.0, DEFAULT_STRENGTH_DB).unwrap();
        assert_eq!(detect(&out, 48_000.0, KEY).unwrap().status, Status::Verified);
    }

    #[test]
    fn a_frame_with_a_wrong_checksum_is_damaged_never_verified() {
        // The frame goes in with a payload byte changed after its CRC was computed, so what comes
        // out has a good header and a bad checksum. That is the case `Damaged` exists for, and the
        // one a reader must not round up to `Verified`.
        let mut bad = payload();
        let last = bad.len() - 1;
        bad[last] ^= 0x55;
        let host = music(seconds_needed() * 2.2, RATE, 7);
        let out = embed(&host, &bad, KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        let found = detect(&out, RATE, KEY).unwrap();
        assert_eq!(found.status, Status::Damaged, "{found:?}");
        assert_eq!(found.frame, bad, "the bytes as read are still reported, for the harness");
    }

    #[test]
    fn audio_too_short_for_one_copy_is_refused() {
        let host = music(5.0, RATE, 1);
        assert_eq!(
            embed(&host, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB),
            Err(SpreadError::TooShort),
        );
    }

    #[test]
    fn bad_inputs_are_refused_rather_than_guessed_at() {
        let host = music(60.0, RATE, 1);
        assert_eq!(embed(&host, &[1, 2, 3], KEY, RATE, -20.0), Err(SpreadError::BadFrame));
        assert_eq!(embed(&host, &payload(), KEY, 0.0, -20.0), Err(SpreadError::BadRate));
        assert_eq!(detect(&host, f64::NAN, KEY), Err(SpreadError::BadRate));
        assert_eq!(detect(&[], RATE, KEY).unwrap().status, Status::NoMark);
        assert_eq!(detect(&vec![0.0; 100_000], RATE, KEY).unwrap().status, Status::NoMark);
    }
}
