//! wasm/src/psycho.rs
//!
//! An objective estimate of how far a mark sits under what the music masks: the noise-to-mask
//! ratio, per critical band and per frame, from a simplified masking model.
//!
//! **This is a model, not a listener.** `docs/steganography.md` is explicit that SNR is not a proxy
//! for audibility and that only a listening verdict decides whether a mark is inaudible. A masking
//! model is a better proxy than SNR, because it knows that a loud tone hides noise near it and not
//! far from it and that quiet passages hide almost nothing, and it is still a proxy: it was fitted to
//! listening tests of other noise on other music, ignores masking in time, and assumes a playback
//! level. What it is good for is comparison and calibration: how much quieter in the model's terms
//! is one setting than another, and where in a track the mark is closest to being heard, so that a
//! listening session can be aimed at the worst passage instead of the average one.
//!
//! The model follows the usual shape of MPEG-1's psychoacoustic model 1 and Johnston's perceptual
//! entropy: critical bands, a spreading function across them (Schroeder's), an offset by how tonal the
//! band is (tones mask noise worse than noise does), and a floor at the threshold in quiet (Terhardt's
//! formula). The threshold in quiet needs a playback level, and a digital file has none, so full scale is
//! taken to be 96 dB SPL, a loud listening level; at a quieter one more of the mark falls below the
//! threshold in quiet and the figures flatter it less.

use crate::fft::fft;

/// Samples per analysis frame, and the hop between frames.
pub const FRAME: usize = 2048;
pub const HOP: usize = 1024;

/// Sound pressure level of a full-scale sine, in dB. An assumption, stated in the module header.
pub const FULL_SCALE_SPL: f64 = 96.0;

/// Critical band edges in Hz (Zwicker's 25 bands up to 15.5 kHz). The last edge is the top of the
/// range the mark is judged over, since there is little music or mark above it and hearing there is poor.
const EDGES: [f64; 25] = [
    0.0, 100.0, 200.0, 300.0, 400.0, 510.0, 630.0, 770.0, 920.0, 1080.0, 1270.0, 1480.0, 1720.0, 2000.0,
    2320.0, 2700.0, 3150.0, 3700.0, 4400.0, 5300.0, 6400.0, 7700.0, 9500.0, 12000.0, 15500.0,
];
/// Critical bands judged.
pub const BANDS: usize = EDGES.len() - 1;

/// Band edges in Hz, for callers that shape something per band.
pub fn band_edges() -> &'static [f64] {
    &EDGES
}

/// The bands judged are those whose centre lies in the carrier's own range. Outside it the mark has
/// nothing but filter leakage, a cell there has a ratio tens of dB under any threshold, and counting
/// them would pull every average toward a figure that says nothing about where the mark is. These are
/// the carrier's band edges in `spread.rs`, and a test there holds them equal.
pub const JUDGED_LOW_HZ: f64 = 250.0;
pub const JUDGED_HIGH_HZ: f64 = 8000.0;

/// What a comparison found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Nmr {
    /// Frames compared, and the (band, frame) cells among them that were judged.
    pub frames: usize,
    pub cells: usize,
    /// Mean noise-to-mask ratio over the judged cells, in dB. Negative is under the threshold.
    pub mean_db: f64,
    /// The ratio that 95% of cells were at or under, in dB. The mean says how the mark is on average and
    /// this says how it is where it is worst, which is where it would be heard.
    pub p95_db: f64,
    /// The single worst frame's mean over its bands, in dB, and its position as a fraction of the file.
    pub worst_frame_db: f64,
    pub worst_frame_at: f64,
    /// The fraction of cells above the threshold (ratio over 0 dB), and above 6 dB under it.
    pub above_threshold: f64,
    pub above_minus_6: f64,
}

/// Threshold in quiet at `khz`, in dB SPL (Terhardt).
fn threshold_in_quiet(khz: f64) -> f64 {
    let f = khz.max(0.02);
    3.64 * f.powf(-0.8) - 6.5 * (-0.6 * (f - 3.3).powi(2)).exp() + 1e-3 * f.powi(4)
}

/// Schroeder's spreading function, in dB, for a masker `dz` Barks below the maskee.
fn spread_db(dz: f64) -> f64 {
    let x = dz + 0.474;
    15.81 + 7.5 * x - 17.5 * (1.0 + x * x).sqrt()
}

/// Power spectrum of a Hann-windowed frame, scaled so that a full-scale sine is `FULL_SCALE_SPL` dB in
/// its peak bin, as linear power. `None` for a frame that runs off the end.
fn power_spectrum(frame: &[f32], window: &[f64], norm: f64) -> Vec<f64> {
    let mut re: Vec<f64> = frame.iter().zip(window).map(|(&x, &w)| x as f64 * w).collect();
    let mut im = vec![0.0; FRAME];
    fft(&mut re, &mut im, false);
    (0..FRAME / 2).map(|k| (re[k] * re[k] + im[k] * im[k]) / (norm * norm)).collect()
}

/// Energy per critical band from a power spectrum, and the band's flatness in dB (0 for a noise-like
/// band, large and negative for a tone-like one).
fn band_energy(power: &[f64], bin_hz: f64) -> ([f64; BANDS], [f64; BANDS]) {
    let mut energy = [0.0f64; BANDS];
    let mut flatness = [0.0f64; BANDS];
    for b in 0..BANDS {
        let lo = (EDGES[b] / bin_hz).ceil() as usize;
        let hi = ((EDGES[b + 1] / bin_hz).ceil() as usize).min(power.len());
        if hi <= lo {
            continue;
        }
        let slice = &power[lo..hi];
        let arithmetic = slice.iter().sum::<f64>() / slice.len() as f64;
        let geometric = (slice.iter().map(|&p| (p + 1e-30).ln()).sum::<f64>() / slice.len() as f64).exp();
        energy[b] = slice.iter().sum();
        flatness[b] = if arithmetic > 1e-30 { 10.0 * (geometric / arithmetic).log10() } else { 0.0 };
    }
    (energy, flatness)
}

/// The masking threshold per band, as linear power, for a frame with these band energies.
fn thresholds(energy: &[f64; BANDS], flatness: &[f64; BANDS], bin_hz: f64) -> [f64; BANDS] {
    let mut out = [0.0f64; BANDS];
    for i in 0..BANDS {
        let zi = i as f64 + 0.5;
        // What every band's energy contributes at this one, spread by distance in Barks.
        let spread: f64 = (0..BANDS)
            .map(|j| energy[j] * 10f64.powf(spread_db(zi - (j as f64 + 0.5)) / 10.0))
            .sum();
        // Tonal bands mask less: 14.5 dB plus the band number below the masker for a tone, 5.5 dB for noise,
        // blended by the band's flatness, with -60 dB of it taken as fully tonal.
        let tonality = (flatness[i] / -60.0).clamp(0.0, 1.0);
        let offset_db = tonality * (14.5 + i as f64) + (1.0 - tonality) * 5.5;
        let masked = spread * 10f64.powf(-offset_db / 10.0);

        // The threshold in quiet, as power in the same units: full scale is FULL_SCALE_SPL, so a level in
        // dB SPL is that many dB relative to a full-scale sine's peak-bin power. Taken at the band's
        // centre, over the band's bins.
        let centre_khz = (EDGES[i] + EDGES[i + 1]) / 2000.0;
        let bins = (((EDGES[i + 1] - EDGES[i]) / bin_hz).max(1.0)).round();
        let quiet = 10f64.powf((threshold_in_quiet(centre_khz) - FULL_SCALE_SPL) / 10.0) * bins;
        out[i] = masked.max(quiet);
    }
    out
}

/// Everything needed to measure one frame the way `nmr` does: the window and normalisation, and the
/// bin spacing.
pub struct FrameMeter {
    window: Vec<f64>,
    norm: f64,
    pub bin_hz: f64,
}

impl FrameMeter {
    pub fn new(sample_rate: f64) -> Self {
        let window: Vec<f64> = (0..FRAME)
            .map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos())
            .collect();
        let norm = window.iter().sum::<f64>() / 2.0;
        FrameMeter { window, norm, bin_hz: sample_rate / FRAME as f64 }
    }

    /// Band energies of `frame`, in the units thresholds are in.
    pub fn energy(&self, frame: &[f32]) -> [f64; BANDS] {
        band_energy(&power_spectrum(frame, &self.window, self.norm), self.bin_hz).0
    }

    /// The masking threshold of `frame`, per band, in the same units.
    pub fn thresholds(&self, frame: &[f32]) -> [f64; BANDS] {
        let (energy, flat) = band_energy(&power_spectrum(frame, &self.window, self.norm), self.bin_hz);
        thresholds(&energy, &flat, self.bin_hz)
    }
}

/// Compare `marked` against `original`: how far the difference sits under what the original masks.
///
/// Only the first `max_frames` frames are judged, spread evenly across the file, so a long track costs a
/// bounded amount. Frames where the original is digital silence are skipped, since there is nothing to
/// mask and nothing to compare. Returns `None` for audio too short to hold a frame or inputs of different
/// lengths.
pub fn nmr(original: &[f32], marked: &[f32], sample_rate: f64, max_frames: usize) -> Option<Nmr> {
    if original.len() != marked.len() || original.len() < FRAME || !(sample_rate > 0.0) || max_frames == 0 {
        return None;
    }
    let window: Vec<f64> = (0..FRAME)
        .map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos())
        .collect();
    // A full-scale sine's peak bin has magnitude A * sum(w) / 2.
    let norm = window.iter().sum::<f64>() / 2.0;
    let bin_hz = sample_rate / FRAME as f64;
    let total_frames = (original.len() - FRAME) / HOP + 1;
    let step = (total_frames / max_frames).max(1);

    let mut cells: Vec<f64> = Vec::new();
    let mut frames = 0usize;
    let (mut worst, mut worst_at) = (f64::NEG_INFINITY, 0.0);
    let (mut sum_frames, mut counted) = (0.0f64, 0usize);
    let _ = (&mut sum_frames, &mut counted);

    for f in (0..total_frames).step_by(step) {
        let start = f * HOP;
        let o = &original[start..start + FRAME];
        if o.iter().all(|&x| x == 0.0) {
            continue;
        }
        let diff: Vec<f32> = o.iter().zip(&marked[start..start + FRAME]).map(|(&a, &b)| b - a).collect();
        let (e_orig, flat) = band_energy(&power_spectrum(o, &window, norm), bin_hz);
        let (e_mark, _) = band_energy(&power_spectrum(&diff, &window, norm), bin_hz);
        let t = thresholds(&e_orig, &flat, bin_hz);

        let mut frame_cells = Vec::with_capacity(BANDS);
        for b in 0..BANDS {
            // Bands above the top of the sample rate's range have no bins to judge.
            let centre = (EDGES[b] + EDGES[b + 1]) / 2.0;
            if EDGES[b + 1] > sample_rate / 2.0 || e_mark[b] <= 0.0 || centre < JUDGED_LOW_HZ || centre > JUDGED_HIGH_HZ {
                continue;
            }
            frame_cells.push(10.0 * (e_mark[b] / t[b]).log10());
        }
        if frame_cells.is_empty() {
            continue;
        }
        frames += 1;
        let frame_mean = frame_cells.iter().sum::<f64>() / frame_cells.len() as f64;
        if frame_mean > worst {
            worst = frame_mean;
            worst_at = start as f64 / original.len() as f64;
        }
        cells.extend(frame_cells);
    }
    if cells.is_empty() {
        return None;
    }
    let n = cells.len() as f64;
    let mean_db = cells.iter().sum::<f64>() / n;
    let above_threshold = cells.iter().filter(|&&c| c > 0.0).count() as f64 / n;
    let above_minus_6 = cells.iter().filter(|&&c| c > -6.0).count() as f64 / n;
    cells.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p95_db = cells[((cells.len() - 1) as f64 * 0.95) as usize];
    Some(Nmr {
        frames,
        cells: cells.len(),
        mean_db,
        p95_db,
        worst_frame_db: worst,
        worst_frame_at: worst_at,
        above_threshold,
        above_minus_6,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 44_100.0;

    fn noise(len: usize, amplitude: f32, seed: u64) -> Vec<f32> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                let u = (crate::lfs::splitmix64(&mut state) >> 40) as f32 / (1u64 << 24) as f32;
                (u - 0.5) * 2.0 * amplitude
            })
            .collect()
    }

    fn sine(hz: f64, len: usize, amplitude: f32) -> Vec<f32> {
        (0..len).map(|i| amplitude * (2.0 * std::f64::consts::PI * hz * i as f64 / RATE).sin() as f32).collect()
    }

    fn add(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b).map(|(&x, &y)| x + y).collect()
    }

    #[test]
    fn a_full_scale_sine_is_the_assumed_spl_in_its_peak_bin() {
        let len = FRAME;
        let window: Vec<f64> = (0..FRAME).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos()).collect();
        let norm = window.iter().sum::<f64>() / 2.0;
        // On a bin centre, so no scalloping.
        let hz = 100.0 * RATE / FRAME as f64;
        let power = power_spectrum(&sine(hz, len, 1.0), &window, norm);
        let peak = power.iter().cloned().fold(0.0f64, f64::max);
        assert!((10.0 * peak.log10()).abs() < 0.1, "the peak is {:.2} dB re full scale", 10.0 * peak.log10());
    }

    #[test]
    fn the_threshold_in_quiet_has_its_known_shape() {
        // About 3 dB SPL at 1 kHz, well below zero near 3.3 kHz where hearing is best, and climbing
        // steeply at the top of the range.
        assert!((threshold_in_quiet(1.0) - 3.4).abs() < 1.0, "{}", threshold_in_quiet(1.0));
        assert!(threshold_in_quiet(3.5) < threshold_in_quiet(1.0));
        assert!(threshold_in_quiet(15.0) > 40.0);
        assert!(threshold_in_quiet(0.05) > threshold_in_quiet(1.0));
    }

    #[test]
    fn the_spreading_function_falls_off_faster_below_the_masker_than_above_it() {
        // A masker hides what is above it more than what is below it, which is why `dz` is the maskee
        // minus the masker.
        assert!(spread_db(2.0) > spread_db(-2.0) + 10.0);
        assert!(spread_db(0.0) > spread_db(3.0));
        assert!(spread_db(0.0) > spread_db(-3.0));
    }

    #[test]
    fn a_louder_mark_is_further_over_the_threshold_by_the_same_number_of_decibels() {
        let host = add(&sine(440.0, 44_100, 0.3), &noise(44_100, 0.05, 1));
        let mark = noise(44_100, 0.002, 2);
        let quiet = nmr(&host, &add(&host, &mark), RATE, 40).unwrap();
        let loud_mark: Vec<f32> = mark.iter().map(|&x| x * 4.0).collect();
        let loud = nmr(&host, &add(&host, &loud_mark), RATE, 40).unwrap();
        // 4x is 12.04 dB. A few bands sit on the threshold in quiet, where the ratio is still linear in
        // the mark, so the mean moves by the full amount.
        assert!((loud.mean_db - quiet.mean_db - 12.04).abs() < 0.5, "{} to {}", quiet.mean_db, loud.mean_db);
    }

    #[test]
    fn the_same_mark_is_less_audible_under_loud_music_than_under_quiet_music() {
        let mark = noise(44_100, 0.001, 3);
        let loud = add(&noise(44_100, 0.3, 4), &sine(1000.0, 44_100, 0.3));
        let quiet: Vec<f32> = loud.iter().map(|&x| x * 0.01).collect();
        let on_loud = nmr(&loud, &add(&loud, &mark), RATE, 40).unwrap();
        let on_quiet = nmr(&quiet, &add(&quiet, &mark), RATE, 40).unwrap();
        assert!(on_loud.mean_db < on_quiet.mean_db - 20.0, "loud {} quiet {}", on_loud.mean_db, on_quiet.mean_db);
    }

    #[test]
    fn a_tone_raises_the_threshold_near_it_far_more_than_far_from_it() {
        // The masking threshold itself, for a loud 1 kHz tone: well above the threshold in quiet in the
        // bands beside it, and no higher than that floor in a band a long way up. A comparison of whole
        // files would be swamped by the spectral leakage of whatever test mark was chosen, which is why
        // this looks at the thresholds.
        let window: Vec<f64> = (0..FRAME).map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / FRAME as f64).cos()).collect();
        let norm = window.iter().sum::<f64>() / 2.0;
        let bin_hz = RATE / FRAME as f64;
        let (energy, flat) = band_energy(&power_spectrum(&sine(1000.0, FRAME, 0.5), &window, norm), bin_hz);
        let t = thresholds(&energy, &flat, bin_hz);
        let db = |p: f64| 10.0 * p.log10();
        let beside = db(t[9]); // 1080 to 1270 Hz
        let far = db(t[20]); // 6400 to 7700 Hz
        let floor_far = threshold_in_quiet(7.05) - FULL_SCALE_SPL + db((((EDGES[21] - EDGES[20]) / bin_hz).round()).max(1.0));
        assert!(beside > far + 30.0, "beside {beside:.1} dB, far {far:.1} dB");
        assert!((far - floor_far).abs() < 1.0, "far from the tone the threshold is the threshold in quiet: {far:.1} against {floor_far:.1}");
    }

    #[test]
    fn an_unchanged_file_has_nothing_to_judge_and_says_so() {
        let host = noise(20_000, 0.2, 5);
        assert_eq!(nmr(&host, &host, RATE, 20), None);
    }

    #[test]
    fn bad_inputs_are_refused() {
        let host = noise(20_000, 0.2, 5);
        assert_eq!(nmr(&host, &host[..100], RATE, 20), None);
        assert_eq!(nmr(&host[..100], &host[..100], RATE, 20), None);
        assert_eq!(nmr(&host, &host, 0.0, 20), None);
        assert_eq!(nmr(&host, &host, RATE, 0), None);
    }

    #[test]
    fn digital_silence_in_the_original_is_skipped_not_judged() {
        let mut host = vec![0.0f32; 30_000];
        let mark = noise(30_000, 0.0001, 6);
        let judged = nmr(&host, &add(&host, &mark), RATE, 40);
        assert_eq!(judged, None);
        host[20_000..].iter_mut().zip(noise(10_000, 0.2, 7)).for_each(|(h, n)| *h = n);
        let partial = nmr(&host, &add(&host, &mark), RATE, 40).unwrap();
        assert!(partial.frames > 0 && partial.frames < 29);
    }
}
