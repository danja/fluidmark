//! wasm/src/mark_stream.rs
//!
//! The masked embedder as a stream: audio goes in a block at a time, of any size, and marked audio comes
//! out a fixed delay later, with nothing allocated while it runs.
//!
//! This is the embedder a plugin needs and the one everything else now uses. The offline call is this
//! stream fed a whole file, so the page, the tools and a plugin in a DAW produce the same bits.
//!
//! How it works, in hops of `HOP` samples and frames of `FRAME`, each frame two hops long and starting
//! one hop before its own:
//!
//! - When hop `k` has arrived, frame `k` (hops `k-1` and `k`) is complete, and its masking threshold is
//!   measured from the host audio exactly as it is.
//! - Frame `k-1` then has the thresholds of its neighbours, and its threshold is the lowest of the three
//!   (the first frame has no past and uses its own). Its carrier is windowed, taken to the frequency domain,
//!   scaled band by band to sit the margin under that threshold, interpolated smoothly in dB between band
//!   centres, brought back and windowed again.
//! - That frame's two halves finish hops `k-2` and `k-1`. Hop `k-2` is complete and is released.
//!
//! So a sample comes out `3 * HOP` samples after it went in, exactly, and that is the plugin's reported
//! latency. The carrier at a position depends on that position and the key and nothing else, so block size
//! and the moment the stream was started change nothing about what a given position receives.
//!
//! The mark is added in the same order as the whole-file embedder always did it, host plus the first frame
//! that touches a sample plus the second, so the two agree to the bit.

use crate::fft::fft;
use crate::psycho::{self, FrameMeter, BANDS, FRAME, HOP};
use crate::resample::Resampler;
use crate::spread::CHIPS;

/// Samples between a sample going in and the same sample coming out marked.
pub const LATENCY: usize = 3 * HOP;

/// One channel's state. Fixed-size arrays and no heap, so a channel's state is allocated once, with the stream.
struct Lane {
    /// Host hops `k-2`, `k-1` and `k`, in a ring by hop number.
    hosts: [[f32; HOP]; 3],
    /// Thresholds and silence flags of frames `k-2`, `k-1` and `k`, in a ring by frame number.
    thresholds: [[f64; BANDS]; 3],
    silent: [bool; 3],
    /// The hop about to be completed: its host samples plus the second half of the frame before.
    pending: [f32; HOP],
    /// Marked hops waiting to be read out, four of them.
    out: [f32; 4 * HOP],
    /// Input samples taken so far, and how many of the hop in progress.
    taken: u64,
    fill: usize,
}

impl Lane {
    fn new() -> Self {
        Lane {
            hosts: [[0.0; HOP]; 3],
            thresholds: [[0.0; BANDS]; 3],
            silent: [true; 3],
            pending: [0.0; HOP],
            out: [0.0; 4 * HOP],
            taken: 0,
            fill: 0,
        }
    }
}

pub struct MaskedStream {
    bits: Vec<f32>,
    period: Vec<f32>,
    resampler: Option<Resampler>,
    pos0: u64,
    margin: f64,
    meter: FrameMeter,
    sine: Vec<f64>,
    centres: [f64; BANDS],
    re: Vec<f64>,
    im: Vec<f64>,
    lanes: Vec<Lane>,
}

/// The carrier at stream position `i`, which is negative before the stream began and then silent.
fn carrier_at(bits: &[f32], period: &[f32], resampler: &Option<Resampler>, pos0: u64, i: i64) -> f32 {
    if i < 0 {
        return 0.0;
    }
    let at = |j: usize| bits[(j / CHIPS) % bits.len()] * period[j % CHIPS];
    let index = pos0 as usize + i as usize;
    match resampler {
        None => at(index),
        Some(r) => r.sample_at(index, at),
    }
}

impl MaskedStream {
    /// A stream of `channels` channels at `sample_rate`, with the mark `margin_db` under the threshold.
    ///
    /// `bits` is the stream of +1/-1 channel bits and `period` one period of the carrier, as `spread` builds
    /// them. `pos0` is the stream position of the first sample, so a plugin can start at the host's timeline
    /// position. Allocates everything it will ever need. `None` for a rate or channel count it cannot work at.
    pub fn new(bits: Vec<f32>, period: Vec<f32>, sample_rate: f64, margin_db: f64, channels: usize, pos0: u64) -> Option<Self> {
        if !(8000.0..=192_000.0).contains(&sample_rate) || !margin_db.is_finite() || channels == 0 || channels > 8 {
            return None;
        }
        if bits.is_empty() || period.len() != CHIPS {
            return None;
        }
        let resampler = if (sample_rate - crate::spread::RATE).abs() < 1e-9 {
            None
        } else {
            // The input is unbounded, so the resampler is told it is as long as an index can be.
            Some(Resampler::new(usize::MAX / 8, crate::spread::RATE, sample_rate)?)
        };
        let edges = psycho::band_edges();
        let mut centres = [0.0f64; BANDS];
        for (b, slot) in centres.iter_mut().enumerate() {
            *slot = (edges[b] + edges[b + 1]) / 2.0;
        }
        Some(MaskedStream {
            bits,
            period,
            resampler,
            pos0,
            margin: 10f64.powf(margin_db / 10.0),
            meter: FrameMeter::new(sample_rate),
            sine: (0..FRAME).map(|j| ((j as f64 + 0.5) * std::f64::consts::PI / FRAME as f64).sin()).collect(),
            centres,
            re: vec![0.0; FRAME],
            im: vec![0.0; FRAME],
            lanes: (0..channels).map(|_| Lane::new()).collect(),
        })
    }

    pub fn channels(&self) -> usize {
        self.lanes.len()
    }

    /// Move the margin. Takes effect at the next frame, and the overlap of the frames' windows is the
    /// crossfade, so the mark's level never steps.
    pub fn set_margin_db(&mut self, margin_db: f64) {
        if margin_db.is_finite() {
            self.margin = 10f64.powf(margin_db / 10.0);
        }
    }

    /// Mark `input` into `output`, one channel's worth, of any length. Output sample `t` is input sample
    /// `t - LATENCY` marked, and silence before that. Allocates nothing.
    pub fn process_channel(&mut self, channel: usize, input: &[f32], output: &mut [f32]) {
        debug_assert_eq!(input.len(), output.len());
        for (i, &x) in input.iter().enumerate() {
            self.push(channel, x);
            let lane = &self.lanes[channel];
            // The sample just taken is number `taken - 1`, and what comes out now is the one `LATENCY` earlier.
            let t = lane.taken - 1;
            output[i] = if t >= LATENCY as u64 { lane.out[((t - LATENCY as u64) as usize) % (4 * HOP)] } else { 0.0 };
        }
    }

    fn push(&mut self, channel: usize, x: f32) {
        let hop = {
            let lane = &mut self.lanes[channel];
            let k = (lane.taken / HOP as u64) as usize;
            lane.hosts[k % 3][lane.fill] = x;
            lane.fill += 1;
            lane.taken += 1;
            if lane.fill < HOP {
                return;
            }
            lane.fill = 0;
            k
        };
        self.hop_arrived(channel, hop);
    }

    /// Hop `k` is complete: measure frame `k`, then do frame `k - 1`.
    fn hop_arrived(&mut self, channel: usize, k: usize) {
        // Frame k: the previous hop then this one, zeros before the stream began.
        let mut frame = [0.0f32; FRAME];
        {
            let lane = &self.lanes[channel];
            if k >= 1 {
                frame[..HOP].copy_from_slice(&lane.hosts[(k - 1) % 3]);
            }
            frame[HOP..].copy_from_slice(&lane.hosts[k % 3]);
        }
        let silent = frame.iter().all(|&v| v == 0.0);
        let thresholds = self.meter.thresholds(&frame);
        {
            let lane = &mut self.lanes[channel];
            lane.silent[k % 3] = silent;
            lane.thresholds[k % 3] = thresholds;
        }
        if k >= 1 {
            self.do_frame(channel, k - 1);
        }
    }

    /// Frame `f`: scale its carrier under the threshold, finish the hop before it, start the hop it begins.
    fn do_frame(&mut self, channel: usize, f: usize) {
        let k = f + 1;
        let mut mark = [0.0f64; FRAME];

        if !self.lanes[channel].silent[f % 3] {
            // The lowest of this frame's threshold and its neighbours'. The first frame has no past.
            let lane = &self.lanes[channel];
            let mut lowest = lane.thresholds[f % 3];
            let before = if f >= 1 { lane.thresholds[(f - 1) % 3] } else { lane.thresholds[f % 3] };
            let after = lane.thresholds[k % 3];
            for b in 0..BANDS {
                lowest[b] = lowest[b].min(before[b]).min(after[b]);
            }

            // The carrier over the frame, at the output rate.
            let start = f as i64 * HOP as i64 - HOP as i64;
            let mut c = [0.0f32; FRAME];
            for (j, slot) in c.iter_mut().enumerate() {
                *slot = carrier_at(&self.bits, &self.period, &self.resampler, self.pos0, start + j as i64);
            }

            let own = self.meter.energy(&c);
            // Gain per band as a power ratio in dB, where the carrier has anything in the band to scale.
            let mut gain_db = [0.0f64; BANDS];
            let mut valid = [0usize; BANDS];
            let mut count = 0;
            for b in 0..BANDS {
                if own[b] > 1e-30 {
                    gain_db[b] = 10.0 * (lowest[b] * self.margin / own[b]).log10();
                    valid[count] = b;
                    count += 1;
                }
            }
            if count > 0 {
                let valid = &valid[..count];
                let centres = &self.centres;
                // The amplitude gain at a frequency: ten to the power of a twentieth of the interpolated dB.
                let amplitude = |hz: f64| -> f64 {
                    let at = valid.partition_point(|&b| centres[b] < hz);
                    let db = if at == 0 {
                        gain_db[valid[0]]
                    } else if at == count {
                        gain_db[valid[count - 1]]
                    } else {
                        let (lo, hi) = (valid[at - 1], valid[at]);
                        let t = (hz - centres[lo]) / (centres[hi] - centres[lo]);
                        gain_db[lo] * (1.0 - t) + gain_db[hi] * t
                    };
                    10f64.powf(db / 20.0)
                };

                for j in 0..FRAME {
                    self.re[j] = c[j] as f64 * self.sine[j];
                    self.im[j] = 0.0;
                }
                fft(&mut self.re, &mut self.im, false);
                for bin in 0..=FRAME / 2 {
                    let g = amplitude(bin as f64 * self.meter.bin_hz);
                    self.re[bin] *= g;
                    self.im[bin] *= g;
                    if bin > 0 && bin < FRAME / 2 {
                        self.re[FRAME - bin] *= g;
                        self.im[FRAME - bin] *= g;
                    }
                }
                fft(&mut self.re, &mut self.im, true);
                for j in 0..FRAME {
                    mark[j] = self.re[j] * self.sine[j];
                }
            }
        }

        let lane = &mut self.lanes[channel];
        // Hop f-1 is finished: what was pending plus the first half of this frame, in that order.
        if f >= 1 {
            let h = f - 1;
            for j in 0..HOP {
                lane.out[(h % 4) * HOP + j] = lane.pending[j] + mark[j] as f32;
            }
        }
        // Hop f begins: its host samples plus the second half of this frame.
        for j in 0..HOP {
            lane.pending[j] = lane.hosts[f % 3][j] + mark[HOP + j] as f32;
        }
    }
}
