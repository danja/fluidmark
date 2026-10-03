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
//! [ sync: 32 keyed bits ][ header: 10 bytes, convolutional code, interleaved ][ body: n bytes, same ]
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
use crate::filter::{highpass, lowpass, BandPass};
use crate::frame::{self, FrameError, HEADER_BYTES};
use crate::lfs::splitmix64;
use crate::mark_stream;
use crate::psycho::FRAME;
#[cfg(test)]
use crate::psycho;
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
///
/// This is a filter on which peaks are worth trying, not the thing that decides a mark is there:
/// the frame's magic, version and CRC-16 decide that. It has to be low, and the reason is not
/// obvious. The spread of the scores is measured from the scores themselves, and every window of
/// the stream contains data bits at full signal strength, so the spread grows with the mark: a
/// perfect mark with no noise at all peaks at only `sqrt(SYNC_BITS)`, about 5.7, of that spread.
/// A threshold of 5 sat almost on the ceiling, and whether a given key's sync word cleared it was
/// a matter of how its sidelobes happened to fall. Roughly two keys in three failed to read their
/// own marks, on a host where the default key was fine.
const SYNC_SIGMAS: f64 = 2.5;

/// Frame lengths, in payload bytes, the pooled sync search tries, up to the point where one copy no
/// longer fits in what was read. A payload of 63 characters is at most 189 bytes of UTF-8.
const POOLED_MAX_LENGTH: usize = 1023;

/// How far a pooled sync score has to stand out. Lower than for one copy's, because the score is a
/// sum over copies and the frame's own checks decide anyway.
const POOLED_SIGMAS: f64 = 3.0;

/// Sync candidates the reader will try, strongest first. Each costs a Hamming decode of one
/// header, which is nothing, and each is gated by the frame's checks before it is believed.
const MAX_CANDIDATES: usize = 16;

/// Most channels one call will take. Stereo is the case that matters; the rest is headroom for
/// surround masters, which are marked channel by channel the same way.
pub const MAX_CHANNELS: usize = 8;

/// Most frames per channel the embedder will take. It makes several copies of a channel while it
/// works, so the limit is about memory rather than time, and it is a refusal, not a truncation:
/// marking the first twelve minutes of a longer file and returning it would be a quiet failure.
pub const MAX_EMBED_FRAMES: usize = 1 << 25;

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
    /// No channels, too many, or a sample count that is not a whole number of frames.
    BadChannels,
    /// More audio than the embedder will hold in memory at once. See `MAX_EMBED_FRAMES`.
    TooLong,
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
    /// How much longer the file was than the mark's own timing, as a ratio: 1.0 when it matched,
    /// 1.0001 for a file slowed by 0.01%. Only ever not 1.0 when the reader had to correct for it.
    pub speed: f64,
}

impl Detection {
    fn none() -> Self {
        Detection { status: Status::NoMark, frame: Vec::new(), sync_sigmas: 0.0, copies: 0, speed: 1.0 }
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
    SYNC_BITS + ecc::coded_bits(HEADER_BYTES) + ecc::coded_bits(frame_bytes - HEADER_BYTES)
}

/// Samples at the mark's own rate that one copy occupies.
pub fn copy_samples(frame_bytes: usize) -> usize {
    copy_bits(frame_bytes) * CHIPS
}

pub(crate) fn band_limit(samples: &[f32]) -> Vec<f32> {
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

/// The host's block powers in the carrier's band, one per `ENV_BLOCK` samples, computed streaming.
///
/// The band-limited host is never held: it is measured a block at a time as it goes by. An earlier
/// version built it whole, and with the copies around it that was most of the memory a long track
/// needed to be marked.
fn band_power(samples: &[f32], sample_rate: f32) -> Vec<f32> {
    let mut band = BandPass::new(BAND_LO, BAND_HI, sample_rate);
    let mut power = Vec::with_capacity(samples.len().div_ceil(ENV_BLOCK));
    for chunk in samples.chunks(ENV_BLOCK) {
        let mut sum = 0.0f32;
        for &x in chunk {
            let b = band.process(x);
            sum += b * b;
        }
        power.push(sum / chunk.len() as f32);
    }
    power
}

/// The level at each block, smoothed over three.
fn level_blocks(power: &[f32]) -> Vec<f32> {
    let blocks = power.len();
    (0..blocks)
        .map(|b| {
            let lo = b.saturating_sub(1);
            let hi = (b + 1).min(blocks - 1);
            let span = &power[lo..=hi];
            (span.iter().sum::<f32>() / span.len() as f32).sqrt()
        })
        .collect()
}

/// The level at sample `i`, interpolated linearly between block centres so the mark's level changes
/// smoothly rather than in steps, which would be audible as a click train.
#[inline]
fn level_at(level: &[f32], i: usize) -> f32 {
    let blocks = level.len();
    let at = (i as f32 - ENV_BLOCK as f32 / 2.0) / ENV_BLOCK as f32;
    let b0 = at.floor().max(0.0) as usize;
    let b1 = (b0 + 1).min(blocks - 1);
    let t = (at - b0 as f32).clamp(0.0, 1.0);
    level[b0.min(blocks - 1)] * (1.0 - t) + level[b1] * t
}

/// How the mark's level is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// `strength_db` is the mark's level relative to the music's own level in the carrier's band, the
    /// same in every band and at every moment. Simple, and blind to what the music hides: it is audible
    /// where the music is sparse and wasteful where it is dense.
    Relative,
    /// `strength_db` is how far under the masking threshold the mark sits, in every critical band and
    /// every frame: -6 puts it at a quarter of the power the model says the music hides. The mark is
    /// shaped to follow the threshold, so it is loud where the music is and quiet where it is not.
    /// The threshold is a model (`psycho.rs`), and a model is not a listener.
    Masked,
}

/// A 64-bit key from text, by FNV-1a over its UTF-8 bytes. Empty text gives `DEFAULT_KEY`, so "no key" is never
/// a different thing from "the default one".
///
/// The same derivation as `keyFromText` in `src/spread.js`, which a test holds equal, so a phrase typed into
/// the page and one typed into a plugin make the same key.
pub fn key_from_text(text: &[u8]) -> u64 {
    if text.is_empty() {
        return DEFAULT_KEY;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in text {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The key used when none is given. Public, in this source file, so a mark made with it can be read by anyone.
pub const DEFAULT_KEY: u64 = 0x0123_4567_89ab_cdef;

/// The bits and the carrier period for a frame and a key, for a streaming embedder that is built from them.
/// `None` for a frame too short to be one.
pub fn stream_parts(frame_bytes: &[u8], key: u64) -> Option<(Vec<f32>, Vec<f32>)> {
    if frame_bytes.len() < HEADER_BYTES {
        return None;
    }
    Some((stream(frame_bytes, key), carrier(key)))
}

/// Add the mark shaped to sit `margin_db` under the masking threshold, in place.
///
/// This is `mark_stream::MaskedStream` fed the whole channel: the plugin and the page run the same code, so
/// they produce the same bits. The stream delays its output by `LATENCY` samples, so the channel is fed
/// followed by that much silence and the output is taken from `LATENCY` onwards. Digital silence is left
/// silent, and the end of the audio is followed by silence, which means the last frame's threshold is the
/// lowest of its own and silence's and the mark fades out over the last hop rather than stopping.
fn embed_masked_in_place(
    samples: &mut [f32],
    bits: &[f32],
    period: &[f32],
    key_rate: (f64, usize),
    margin_db: f64,
) {
    let (sample_rate, _) = key_rate;
    let Some(mut stream) =
        mark_stream::MaskedStream::new(bits.to_vec(), period.to_vec(), sample_rate, margin_db, 1, 0)
    else {
        return;
    };
    let n = samples.len();
    // A block at a time, so a long channel does not need a second copy of itself. Input is read from the
    // slice before the output for the same stretch is written, and output lags input, so it can be written
    // over what has already been read.
    const BLOCK: usize = 4096;
    let mut input = [0.0f32; BLOCK];
    let mut output = [0.0f32; BLOCK];
    let mut t = 0usize;
    while t < n + mark_stream::LATENCY {
        let len = BLOCK.min(n + mark_stream::LATENCY - t);
        for (i, slot) in input[..len].iter_mut().enumerate() {
            *slot = if t + i < n { samples[t + i] } else { 0.0 };
        }
        stream.process_channel(0, &input[..len], &mut output[..len]);
        for (i, &y) in output[..len].iter().enumerate() {
            let time = t + i;
            if time >= mark_stream::LATENCY {
                samples[time - mark_stream::LATENCY] = y;
            }
        }
        t += len;
    }
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
    let mut out = samples.to_vec();
    embed_in_place(&mut out, frame_bytes, key, sample_rate, strength_db)?;
    Ok(out)
}

/// `embed`, writing the mark into `samples` itself.
///
/// Nothing the size of the track is allocated beyond the track: the host is measured in one pass,
/// into a few floats per thousand samples, and the mark is then computed sample by sample as it is
/// added, which can be done in place because each output reads only its own input. Nothing is
/// touched when an error is returned.
pub fn embed_in_place(
    samples: &mut [f32],
    frame_bytes: &[u8],
    key: u64,
    sample_rate: f64,
    strength_db: f64,
) -> Result<(), SpreadError> {
    embed_level_in_place(samples, frame_bytes, key, sample_rate, strength_db, Level::Relative)
}

/// `embed_in_place` with the level set either relative to the music or under the masking threshold.
pub fn embed_level_in_place(
    samples: &mut [f32],
    frame_bytes: &[u8],
    key: u64,
    sample_rate: f64,
    strength_db: f64,
    level: Level,
) -> Result<(), SpreadError> {
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
    if level == Level::Masked {
        if samples.len() < FRAME {
            return Err(SpreadError::TooShort);
        }
        embed_masked_in_place(samples, &bits, &period, (sample_rate, n44), strength_db);
        return Ok(());
    }
    let carrier_at = |i: usize| bits[(i / CHIPS) % bits.len()] * period[i % CHIPS];

    let level = level_blocks(&band_power(samples, sample_rate as f32));
    let gain = 10f32.powf(strength_db as f32 / 20.0);

    if (sample_rate - RATE).abs() < 1e-9 {
        for (i, x) in samples.iter_mut().enumerate() {
            *x += gain * level_at(&level, i) * carrier_at(i);
        }
    } else {
        // The mark is defined at 44.1 kHz and the track is not, so each output sample is the
        // carrier at 44.1 kHz resampled, computed where it is needed. Past the end of what the
        // resampler produces the mark is silence, as it always was.
        let resampler = resample::Resampler::new(n44, RATE, sample_rate).ok_or(SpreadError::BadRate)?;
        for (i, x) in samples.iter_mut().enumerate() {
            let w = if i < resampler.out_len() { resampler.sample_at(i, &carrier_at) } else { 0.0 };
            *x += gain * level_at(&level, i) * w;
        }
    }
    Ok(())
}

/// Coefficients of a prediction-error filter `1 + a1 z^-1 + ... + ap z^-p`, fitted to `samples`
/// by Levinson-Durbin, or `None` for a signal with no energy to fit.
pub(crate) fn whitening_filter(samples: &[f32]) -> Option<Vec<f64>> {
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

pub(crate) fn fir(samples: &[f32], a: &[f64]) -> Vec<f32> {
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
    if total_blocks < 4 {
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
    let header_bits = ecc::coded_bits(HEADER_BYTES);
    let header = ecc::decode(&ecc::deinterleave(&soft[SYNC_BITS..SYNC_BITS + header_bits], key ^ K_HEADER), HEADER_BYTES)
        .unwrap_or_default();
    let length = if header.len() == HEADER_BYTES { u16::from_le_bytes([header[6], header[7]]) as usize } else { 0 };
    (header, length)
}

fn header_is_plausible(header: &[u8]) -> bool {
    header.len() == HEADER_BYTES && header[0..4] == frame::MAGIC && header[4] == frame::VERSION
}

/// Blocks folded together to place the bit boundary at one point in the file, when tracking timing.
/// Longer runs give a cleaner peak, about the square root of their length, and tolerate less drift
/// within them, so they are tried first, and shorter ones, which tolerate more, when they find nothing.
/// A mark 30 dB under the music has a peak too faint to place from twelve blocks and plain from forty-eight,
/// and a clock error of 30 parts per million moves the boundary by three samples across those.
const TRACK_BLOCKS: [usize; 4] = [48, 24, 12, 6];

/// Points along the file at which the boundary is placed. Its drift between them is the timing.
const TRACK_SPANS: usize = 32;

/// Fewest points that must place the boundary for a timing estimate to be believed.
const TRACK_MIN_SPANS: usize = 6;

/// Blocks folded per candidate speed in the coarse scan, and the scan's grid. The fold tolerates
/// a speed error of several parts in ten thousand at this length, so a step of 8e-4 over plus or
/// minus 8% finds any change a listener would call a change in tempo.
const SCAN_BLOCKS: usize = 6;
const SCAN_STEP: f64 = 8e-4;
const SCAN_STEPS: i32 = 100;

/// How far a candidate speed's boundary peak has to stand out to be taken up.
const SCAN_MIN_SIGMAS: f64 = 8.0;

/// Samples of lead-in given to the filters ahead of a span, so their start-up is not in it.
const FILTER_LEAD: usize = 512;

/// Where the bit boundary falls in `samples[start..start + blocks * CHIPS]`, and how clearly.
fn span_boundary(
    samples: &[f32],
    start: usize,
    blocks: usize,
    a: &[f64],
    reference: &[f32],
) -> Option<(usize, f64)> {
    let len = blocks * CHIPS;
    if start < FILTER_LEAD || start + len > samples.len() {
        return None;
    }
    let raw = &samples[start - FILTER_LEAD..start + len];
    let y = band_limit(&fir(raw, a));
    find_boundary(&y[FILTER_LEAD..], reference)
}

/// The file's speed relative to the mark's own timing, as a drift (0.0001 is 0.01% slow), found by
/// following where the bit boundary falls along the file.
///
/// The boundary is placed from a short run of blocks at each of several points. At the mark's own
/// timing it falls at the same place modulo one carrier period at every point; in a file that has
/// been slowed it moves by the drift times the distance. The moves are unwrapped, since a step is
/// less than half a period, and a line is fitted. Short runs tolerate a drift of a few parts in ten
/// thousand without losing the peak, and the line is good to about a part in a million over a
/// minute, which is what the full reader needs: it loses its peak past about three parts in a
/// hundred thousand.
fn track_speed(samples: &[f32], key: u64) -> Option<f64> {
    TRACK_BLOCKS.iter().find_map(|&blocks| track_speed_blocks(samples, key, blocks))
}

fn track_speed_blocks(samples: &[f32], key: u64, blocks: usize) -> Option<f64> {
    let span = blocks * CHIPS;
    if samples.len() < FILTER_LEAD + span * 2 * TRACK_MIN_SPANS {
        return None;
    }
    let a = whitening_filter(samples)?;
    let reference = expected_carrier(key, &a);

    let usable = samples.len() - FILTER_LEAD - span;
    let spans = TRACK_SPANS.min(usable / (2 * span)).max(TRACK_MIN_SPANS);
    let step = usable / (spans - 1);

    let n = CHIPS as f64;
    let mut points: Vec<(f64, f64)> = Vec::new(); // (position, unwrapped boundary phase)
    let mut previous: Option<f64> = None;
    for i in 0..spans {
        let start = FILTER_LEAD + i * step;
        let Some((offset, _)) = span_boundary(samples, start, blocks, &a, &reference) else {
            continue;
        };
        let phase = ((start + offset) % CHIPS) as f64;
        let unwrapped = match (previous, points.last()) {
            (Some(prev_raw), Some(&(_, last))) => {
                let mut d = phase - prev_raw;
                d -= n * (d / n).round();
                last + d
            }
            _ => phase,
        };
        previous = Some(phase);
        points.push((start as f64, unwrapped));
    }

    let fit = |pts: &[(f64, f64)]| -> (f64, f64) {
        let count = pts.len() as f64;
        let mx = pts.iter().map(|p| p.0).sum::<f64>() / count;
        let my = pts.iter().map(|p| p.1).sum::<f64>() / count;
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
        let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        let slope = if sxx > 0.0 { sxy / sxx } else { 0.0 };
        (slope, my - slope * mx)
    };

    if points.len() < TRACK_MIN_SPANS {
        return None;
    }
    let (slope, intercept) = fit(&points);
    // One pass of dropping points that sit far from the line, since a span in a quiet passage can
    // place the boundary somewhere that is not the mark's, and one such point tilts the whole fit.
    let kept: Vec<(f64, f64)> = points
        .iter()
        .copied()
        .filter(|p| (p.1 - (slope * p.0 + intercept)).abs() <= 8.0)
        .collect();
    if kept.len() < TRACK_MIN_SPANS {
        return None;
    }
    let (slope, intercept) = fit(&kept);
    let rms = (kept.iter().map(|p| (p.1 - (slope * p.0 + intercept)).powi(2)).sum::<f64>() / kept.len() as f64).sqrt();
    // A line that the points do not lie on is not a speed. Placing a boundary is good to a sample or
    // two when the drift inside a run is small and to several when it is not (a drift of a tenth of
    // a percent smears a run of twelve blocks by 25 samples), and a fit worse than that is
    // following noise: random phases would leave almost nothing within eight samples of any line.
    if rms > 5.0 || slope.abs() < 2e-7 || slope.abs() > 0.05 {
        return None;
    }
    Some(slope)
}

/// A coarse speed, as a ratio, found by trying a grid of them and keeping the one under which the
/// boundary peak is strongest at two points in the file.
fn scan_speed(samples: &[f32], key: u64) -> Option<f64> {
    let span = SCAN_BLOCKS * CHIPS;
    let reach = ((span + FILTER_LEAD) as f64 * (1.0 + SCAN_STEP * SCAN_STEPS as f64)).ceil() as usize + 64;
    if samples.len() < 3 * reach {
        return None;
    }
    let a = whitening_filter(samples)?;
    let reference = expected_carrier(key, &a);
    let positions = [samples.len() / 3, 2 * samples.len() / 3];

    let at_speed = |position: usize, r: f64| -> Option<f64> {
        let take = (((span + FILTER_LEAD) as f64 * r).ceil() as usize + 64).min(samples.len() - position);
        let fixed = resample::resample(&samples[position..position + take], RATE * r, RATE);
        if fixed.len() < FILTER_LEAD + span {
            return None;
        }
        let y = band_limit(&fir(&fixed[..FILTER_LEAD + span], &a));
        find_boundary(&y[FILTER_LEAD..], &reference).map(|(_, sigmas)| sigmas)
    };

    let mut best: Option<(f64, f64)> = None;
    for step in -SCAN_STEPS..=SCAN_STEPS {
        if step == 0 {
            continue;
        }
        let r = 1.0 + step as f64 * SCAN_STEP;
        // The first point alone is enough to reject most candidates, so the second is only paid for
        // by those that pass.
        let Some(first) = at_speed(positions[0], r).filter(|&s| s >= SCAN_MIN_SIGMAS) else {
            continue;
        };
        let Some(second) = at_speed(positions[1], r).filter(|&s| s >= SCAN_MIN_SIGMAS) else {
            continue;
        };
        let score = first + second;
        if best.map_or(true, |(_, b)| score > b) {
            best = Some((r, score));
        }
    }
    best.map(|(r, _)| r)
}

/// Speeds worth trying, most likely first. Empty when nothing in the file looks like the mark at
/// any speed, which is what an unmarked file gives.
fn estimate_speeds(at_rate: &[f32], key: u64) -> Vec<f64> {
    if let Some(drift) = track_speed(at_rate, key) {
        return vec![1.0 + drift];
    }
    let Some(coarse) = scan_speed(at_rate, key) else {
        return Vec::new();
    };
    // The coarse speed is good to a few parts in ten thousand, which is not enough for the full
    // reader. Undo it and track what is left.
    let fixed = resample::resample(at_rate, RATE * coarse, RATE);
    match track_speed(&fixed, key) {
        Some(rest) => vec![coarse * (1.0 + rest), coarse],
        None => vec![coarse],
    }
}

/// Try to read a frame from soft bit values, taking `start` to be where a copy begins.
///
/// Reads the header from that one copy, takes the frame's length from it, and so knows the period of
/// the repeats and can combine every copy before reading again. `None` is for anything short of a
/// header and a body that the frame's own magic and version accept.
fn complete_candidate(soft: &[f32], start: usize, polarity: f32, key: u64) -> Option<(Status, Vec<u8>, usize)> {
    let header_bits = ecc::coded_bits(HEADER_BYTES);
    if start + SYNC_BITS + header_bits > soft.len() {
        return None;
    }
    let single: Vec<f32> = soft[start..start + SYNC_BITS + header_bits].iter().map(|&z| z * polarity).collect();
    let (header, length) = read_copy(&single, key);
    if !header_is_plausible(&header) {
        return None;
    }
    combine_and_read(soft, start, length, polarity, key)
}

/// Combine every copy of a frame of `length` payload bytes, taking `start` to be where one begins,
/// and read the frame out of the sum.
///
/// The period of the repeats follows from the length, and every copy is added in, including the
/// partial ones at either end of what was read: a copy cut off by the end of the file or by a crop
/// still carries values for the part that is there, and a position a copy does not reach simply gets
/// nothing from it. Counting only whole copies threw away most of a track that was only a little longer
/// than one, which is exactly where the extra were needed.
///
/// The length is read again from the combination and has to agree with the one the period came from.
/// A header too damaged to say how long the frame is once indexed past the end of the combined values
/// and aborted the reader, which in Wasm is a trap and not an error.
fn combine_and_read(soft: &[f32], start: usize, length: usize, polarity: f32, key: u64) -> Option<(Status, Vec<u8>, usize)> {
    let header_bits = ecc::coded_bits(HEADER_BYTES);
    let period = copy_bits(HEADER_BYTES + length);
    if period > soft.len() + period / 2 {
        return None;
    }
    let mut combined = vec![0.0f32; period];
    let mut whole = 0usize;
    let mut seen = 0usize;
    let mut at = (start % period) as isize - period as isize;
    while at < soft.len() as isize {
        let from = at.max(0) as usize;
        let to = ((at + period as isize).min(soft.len() as isize)).max(0) as usize;
        if to > from {
            let offset = (from as isize - at) as usize;
            for (slot, &z) in combined[offset..].iter_mut().zip(&soft[from..to]) {
                *slot += z * polarity;
            }
            seen += to - from;
            if to - from == period {
                whole += 1;
            }
        }
        at += period as isize;
    }
    // A count of whole copies of zero is real and common for a short file; what is reported is how
    // many copies' worth of values were combined, never less than one.
    let copies = whole.max(seen / period).max(1);

    // Position `i` of `combined` is position `i` of the copy: `start` modulo the period is where a
    // copy begins in the soft values, and every addition above was aligned to it.
    let (header, combined_length) = read_copy(&combined, key);
    if !header_is_plausible(&header) || combined_length != length {
        return None;
    }
    let body_start = SYNC_BITS + header_bits;
    let body_bits = ecc::coded_bits(length);
    let body = ecc::decode(&ecc::deinterleave(combined.get(body_start..body_start + body_bits)?, key ^ K_BODY), length)?;

    let mut frame_bytes = header;
    frame_bytes.extend_from_slice(&body);
    let status = match frame::decode(&frame_bytes) {
        Ok(_) => Status::Verified,
        Err(FrameError::NoMark) | Err(FrameError::TooShort) => return None,
        Err(_) => Status::Damaged,
    };
    Some((status, frame_bytes, copies))
}

/// Everything after the soft values: find where copies begin, combine them, read the frame.
///
/// Sync candidates come from two places. The sync word's own score at each position, which finds
/// a copy from that copy alone. And, first, the sync scores *pooled across copies*: for every frame
/// length whose copy fits and every offset, the scores at one period apart are summed. A mark that is
/// faint enough for one copy's sync word to be no louder than the false peaks around it is not faint
/// to the sum of three, and the sum also names the length, so the header need not be read to learn it.
/// At weak marks this was what limited the reader, not the code or the boundary.
fn read_soft(soft: &[f32], key: u64, pooled: bool) -> Detection {
    let sync = sync_word(key);
    let positions = soft.len() - SYNC_BITS + 1;
    let scores: Vec<f64> = (0..positions)
        .map(|j| sync.iter().zip(&soft[j..j + SYNC_BITS]).map(|(&s, &z)| (s * z) as f64).sum())
        .collect();
    let mut magnitudes: Vec<f64> = scores.iter().map(|s| s.abs()).collect();
    let sigma = 1.4826 * median(&mut magnitudes);
    if !(sigma > 0.0) {
        return Detection::none();
    }

    // Pooled hypotheses: (z, length, offset, polarity), best first.
    let mut pooled_hypotheses: Vec<(f64, usize, usize, f32)> = Vec::new();
    if pooled {
        for length in 0..=POOLED_MAX_LENGTH {
            let period = copy_bits(HEADER_BYTES + length);
            if period > soft.len() {
                break;
            }
            for offset in 0..period.min(positions) {
                let (mut sum, mut terms) = (0.0f64, 0usize);
                let mut at = offset;
                while at < positions {
                    sum += scores[at];
                    terms += 1;
                    at += period;
                }
                // Under no mark the sum of `terms` scores is about `sigma * sqrt(terms)`, so this is
                // comparable across lengths that have different numbers of copies.
                let z = sum.abs() / (sigma * (terms as f64).sqrt());
                if terms >= 2 && z >= POOLED_SIGMAS {
                    pooled_hypotheses.push((z, length, offset, sum.signum() as f32));
                }
            }
        }
        pooled_hypotheses.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        pooled_hypotheses.truncate(MAX_CANDIDATES);
    }
    for &(z, length, offset, polarity) in &pooled_hypotheses {
        if let Some((status, frame_bytes, copies)) = combine_and_read(soft, offset, length, polarity, key) {
            return Detection { status, frame: frame_bytes, sync_sigmas: z, copies, speed: 1.0 };
        }
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
        if let Some((status, frame_bytes, copies)) = complete_candidate(soft, start, polarity, key) {
            return Detection {
                status,
                frame: frame_bytes,
                sync_sigmas: scores[start].abs() / sigma,
                copies,
                speed: 1.0,
            };
        }
    }
    Detection::none()
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

    let straight = detect_at_rate(&at_rate, key);
    if straight.status != Status::NoMark {
        return Ok(straight);
    }

    // Nothing at the rate the file claims. A file that has been slowed or sped up, or played
    // through a clock that is not quite the one it was recorded with, carries the mark at a
    // slightly different period, and the fixed-period reader above finds nothing in it. The
    // timing is estimated from the mark itself and undone, and the same reader is run again. Every
    // result still has to pass the frame's own checks, so this adds tries, not false positives.
    let mut damaged: Option<Detection> = None;
    for speed in estimate_speeds(&at_rate, key) {
        let fixed = resample::resample(&at_rate, RATE * speed, RATE);
        let mut found = detect_at_rate(&fixed, key);
        found.speed = speed;
        if found.status == Status::Verified {
            return Ok(found);
        }
        // The estimate is good to a few parts per million, and the reader loses its peak at a few
        // tens, so most files read first time. One that does not, whether it found a damaged mark or
        // nothing, is tracked again on the corrected audio and read once more with what is left.
        if let Some(rest) = track_speed(&fixed, key) {
            let refined = speed * (1.0 + rest);
            let again = resample::resample(&at_rate, RATE * refined, RATE);
            let mut second = detect_at_rate(&again, key);
            second.speed = refined;
            if second.status == Status::Verified {
                return Ok(second);
            }
            if second.status == Status::Damaged && damaged.is_none() {
                damaged = Some(second);
            }
        }
        if found.status == Status::Damaged && damaged.is_none() {
            damaged = Some(found);
        }
    }
    Ok(damaged.unwrap_or(straight))
}

/// The reader proper, for audio already at the mark's own rate and timing.
fn detect_at_rate(at_rate: &[f32], key: u64) -> Detection {
    if at_rate.len() < 8 * CHIPS {
        return Detection::none();
    }

    let Some(a) = whitening_filter(at_rate) else {
        return Detection::none();
    };
    let y = band_limit(&fir(at_rate, &a));
    let reference = expected_carrier(key, &a);

    let Some((boundary, _)) = find_boundary(&y, &reference) else {
        return Detection::none();
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
    if soft.len() < SYNC_BITS + ecc::coded_bits(HEADER_BYTES) {
        return Detection::none();
    }

    read_soft(&soft, key, true)
}


/// Check a planar buffer's shape and return the frames per channel.
fn frames_of(total: usize, channels: usize) -> Result<usize, SpreadError> {
    if channels == 0 || channels > MAX_CHANNELS || total % channels != 0 {
        return Err(SpreadError::BadChannels);
    }
    Ok(total / channels)
}

/// `frames_of`, and a refusal of anything the embedder would not hold in memory.
fn embed_frames(total: usize, channels: usize) -> Result<usize, SpreadError> {
    let frames = frames_of(total, channels)?;
    if frames > MAX_EMBED_FRAMES {
        return Err(SpreadError::TooLong);
    }
    Ok(frames)
}

/// Mark audio of several channels, laid out planar: all of channel 0, then all of channel 1, and
/// so on, `samples.len() / channels` frames each.
///
/// Every channel carries the **same** stream, on the same carrier, from sample zero, each at its
/// own channel's level. That is the policy, and it is what makes the mark survive the changes
/// stereo material usually goes through: a fold to mono adds the channels' carriers in phase, a
/// single channel carries the whole mark by itself, and a channel that is silent stays silent.
/// The cost is that it is not independent between channels, so nothing is gained from stereo
/// except those survivals.
pub fn embed_planar(
    samples: &[f32],
    channels: usize,
    frame_bytes: &[u8],
    key: u64,
    sample_rate: f64,
    strength_db: f64,
) -> Result<Vec<f32>, SpreadError> {
    let mut out = samples.to_vec();
    embed_planar_in_place(&mut out, channels, frame_bytes, key, sample_rate, strength_db)?;
    Ok(out)
}

/// `embed_planar`, in place. A refusal comes before any channel is touched, since every reason for
/// one is the same for all channels.
pub fn embed_planar_in_place(
    samples: &mut [f32],
    channels: usize,
    frame_bytes: &[u8],
    key: u64,
    sample_rate: f64,
    strength_db: f64,
) -> Result<(), SpreadError> {
    embed_planar_level_in_place(samples, channels, frame_bytes, key, sample_rate, strength_db, Level::Relative)
}

/// `embed_planar_in_place` with the level mode chosen.
pub fn embed_planar_level_in_place(
    samples: &mut [f32],
    channels: usize,
    frame_bytes: &[u8],
    key: u64,
    sample_rate: f64,
    strength_db: f64,
    level: Level,
) -> Result<(), SpreadError> {
    let frames = embed_frames(samples.len(), channels)?;
    for channel in samples.chunks_exact_mut(frames.max(1)) {
        embed_level_in_place(channel, frame_bytes, key, sample_rate, strength_db, level)?;
    }
    Ok(())
}

/// Look for a mark in planar audio, by reading the average of its channels.
///
/// The average is what a fold to mono gives and what a single channel is half of, so it is the
/// one signal in which every way the file might have been folded, split or left alone still has
/// the mark. Only the first `MAX_ANALYSIS` frames are read.
pub fn detect_planar(
    samples: &[f32],
    channels: usize,
    sample_rate: f64,
    key: u64,
) -> Result<Detection, SpreadError> {
    let frames = frames_of(samples.len(), channels)?;
    if channels == 1 {
        return detect(samples, sample_rate, key);
    }
    let used = frames.min(MAX_ANALYSIS);
    let scale = 1.0 / channels as f32;
    let mut mid = vec![0.0f32; used];
    for channel in samples.chunks_exact(frames.max(1)) {
        for (m, &x) in mid.iter_mut().zip(&channel[..used]) {
            *m += x * scale;
        }
    }
    detect(&mid, sample_rate, key)
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
    fn every_key_reads_its_own_mark_not_only_the_lucky_ones() {
        // The bug this guards: the sync threshold sat almost on the ceiling a perfect mark can
        // reach, so whether a key cleared it depended on its sync word, and on a real recording
        // about two keys in three failed to read their own marks. The default key happened to be
        // one that passed, which is how the first measurements were all fine. One key is not a test
        // of this, so it runs sixteen, on a host whose level moves as a recording's does. With the
        // old threshold of 5.0 one of them fails here, and more on real audio.
        let host = dynamic(seconds_needed() * 2.2, 9);
        let mut failed = Vec::new();
        for key in 1u64..=16 {
            let out = embed(&host, &payload(), key, RATE, -26.0).unwrap();
            if detect(&out, RATE, key).unwrap().status != Status::Verified {
                failed.push(key);
            }
        }
        assert!(failed.is_empty(), "keys that could not read their own mark: {failed:?}");
    }

    #[test]
    fn the_sync_threshold_stays_well_below_the_ceiling_a_perfect_mark_reaches() {
        // The reasoning is on the constant. A perfect mark peaks at about sqrt(SYNC_BITS) of the
        // spread of the scores, so a threshold near that is a threshold some keys cannot clear.
        let ceiling = (SYNC_BITS as f64).sqrt();
        assert!(SYNC_SIGMAS <= 0.6 * ceiling, "{SYNC_SIGMAS} is too close to the ceiling {ceiling:.1}");
    }

    /// Music whose level moves around, as real recordings do: a new gain every few thousand
    /// samples, log-uniform over 30 dB, so the soft values differ a lot in size from bit to bit.
    fn dynamic(seconds: f64, seed: u64) -> Vec<f32> {
        let host = music(seconds, RATE, seed);
        let mut state = seed ^ 0xfeed;
        let mut gain = 1.0f32;
        host.iter()
            .enumerate()
            .map(|(i, &x)| {
                if i % 3001 == 0 {
                    let u = (splitmix64(&mut state) >> 40) as f32 / (1u64 << 24) as f32;
                    gain = 10f32.powf(-1.5 * u);
                }
                x * gain
            })
            .collect()
    }


    #[test]
    fn a_file_slowed_or_sped_up_is_still_read_and_the_speed_is_reported() {
        // The reader is told 44.1 kHz and the file is not quite that: a clock that is slightly off,
        // a tempo change, a PAL-style speed-up. A fixed-period reader loses even 30 parts per
        // million of this over a minute, which is why it estimates the timing from the mark.
        let (_, out) = marked(seconds_needed() * 2.2);
        for ratio in [1.00003f64, 1.0001, 1.01, 0.96, 1.06] {
            let changed = resample::resample(&out, RATE, RATE * ratio);
            let found = detect(&changed, RATE, KEY).unwrap();
            assert_eq!(found.status, Status::Verified, "ratio {ratio}: {found:?}");
            assert_eq!(found.frame, payload(), "ratio {ratio}");
            assert!((found.speed - ratio).abs() < 2e-4, "ratio {ratio} reported as {}", found.speed);
        }
    }

    #[test]
    fn a_file_at_its_own_timing_reports_a_speed_of_one() {
        let (_, out) = marked(seconds_needed() * 2.2);
        assert_eq!(detect(&out, RATE, KEY).unwrap().speed, 1.0);
    }

    #[test]
    fn the_speed_search_does_not_find_a_mark_that_is_not_there() {
        // Searching over speeds is more chances to see something, so the cases that must stay
        // empty are run through it: unmarked music, a mark under another key, a changed speed
        // with no mark at all.
        let host = music(seconds_needed() * 2.2, RATE, 17);
        for ratio in [1.0f64, 1.0003, 0.97] {
            let changed = resample::resample(&host, RATE, RATE * ratio);
            assert_eq!(detect(&changed, RATE, KEY).unwrap().status, Status::NoMark, "unmarked at {ratio}");
        }
        let (_, out) = marked(seconds_needed() * 2.2);
        let slowed = resample::resample(&out, RATE, RATE * 1.002);
        assert_ne!(detect(&slowed, RATE, KEY ^ 7).unwrap().status, Status::Verified);
    }

    #[test]
    fn speed_tracking_places_a_known_drift() {
        let (_, out) = marked(seconds_needed() * 2.2);
        let slowed = resample::resample(&out, RATE, RATE * 1.0002);
        let drift = track_speed(&slowed, KEY).expect("a drift is found");
        assert!((drift - 0.0002).abs() < 5e-6, "found {drift}");
        // And none in a file that has none, rather than a small invented one.
        assert!(track_speed(&out, KEY).is_none());
    }


    #[test]
    fn a_track_only_a_little_longer_than_one_copy_still_reads_after_a_crop() {
        // 1.7 copies, then the first 5% cut off: no whole copy is left, only the tail of one and the
        // head of the next. Counting whole copies only would find nothing; combining what is there
        // reads it. This is the shape of a short clip, and it is where the repeats are needed most.
        let host = music(seconds_needed() * 1.7, RATE, 21);
        let out = embed(&host, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        let cropped = attack::crop(&out, (out.len() as f64 * 0.05) as usize, out.len());
        let found = detect(&cropped, RATE, KEY).unwrap();
        assert_eq!(found.status, Status::Verified, "{found:?}");
        assert_eq!(found.frame, payload());
        assert!(found.copies >= 1);
    }


    #[test]
    fn someone_with_no_key_can_recover_the_carrier_from_the_audio_alone() {
        // A characterisation, not a goal. The carrier is one waveform repeated, so stacking blocks with
        // the signs that make them agree recovers it without the key, and this measures how closely.
        // What that lets an attacker do to the mark is measured on real music by the harness, because
        // a synthetic host whose partials repeat from block to block lets the stack pick up the music
        // as well, which says something about the host and not about the mark. If the scheme is ever
        // changed so that this stops being true, the documentation's section on removal is what to
        // update, and this test is what turns red.
        let (_, out) = marked(seconds_needed() * 2.2);
        let est = crate::estimate::analyse(&out).expect("estimates");
        let reference = expected_carrier(KEY, &est.whitener);
        let rn = reference.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
        let best = (0..CHIPS)
            .map(|shift| (0..CHIPS).map(|i| est.carrier[i] * reference[(i + shift) % CHIPS] as f64).sum::<f64>().abs() / rn)
            .fold(0.0f64, f64::max);
        assert!(best > 0.9, "the estimate has a cosine of {best:.3} with the true carrier");
    }


    fn masked(host: &[f32], margin_db: f64, rate: f64) -> Vec<f32> {
        let mut out = host.to_vec();
        embed_level_in_place(&mut out, &payload(), KEY, rate, margin_db, Level::Masked).expect("embeds");
        out
    }

    #[test]
    fn the_bands_the_audibility_model_judges_are_the_carriers_own() {
        assert_eq!(psycho::JUDGED_LOW_HZ, BAND_LO as f64);
        assert_eq!(psycho::JUDGED_HIGH_HZ, BAND_HI as f64);
    }

    #[test]
    fn a_mark_under_the_masking_threshold_sits_where_it_was_asked_to() {
        // By construction the modelled ratio should land near the margin, and this checks the plumbing
        // that makes it so: the thresholds, the per-band scaling and the overlap-add. The model is the
        // same one that does the measuring, so agreement is a check that the shaping works and says
        // nothing about what is audible.
        let steady = music(seconds_needed() * 1.3, RATE, 11);
        for margin in [-6.0f64, -12.0, -20.0] {
            let out = masked(&steady, margin, RATE);
            let r = psycho::nmr(&steady, &out, RATE, 200).expect("judged");
            assert!((r.mean_db - margin).abs() < 3.0, "margin {margin}: mean {:.1}", r.mean_db);
            assert!(r.p95_db < margin + 6.0, "margin {margin}: 95th percentile {:.1}", r.p95_db);
        }
        // A host whose level jumps about is judged against each frame's own threshold, and the mark is
        // set against the lowest of three neighbours, on purpose: a mark under the threshold in the quiet
        // before a loud note is under it at the note, and the other way about is where pre-echo is heard.
        // So it sits under the margin there, by a few dB, and never over it.
        let jumpy = dynamic(seconds_needed() * 1.3, 11);
        let out = masked(&jumpy, -6.0, RATE);
        let r = psycho::nmr(&jumpy, &out, RATE, 200).expect("judged");
        assert!(r.mean_db < -6.0 + 1.0 && r.mean_db > -6.0 - 9.0, "jumpy host: mean {:.1}", r.mean_db);
    }

    #[test]
    fn a_mark_shaped_under_the_threshold_still_reads() {
        let host = music(seconds_needed() * 2.2, RATE, 7);
        let out = masked(&host, -6.0, RATE);
        let found = detect(&out, RATE, KEY).unwrap();
        assert_eq!(found.status, Status::Verified, "{found:?}");
        assert_eq!(found.frame, payload());
    }

    #[test]
    fn masked_marking_is_deterministic_and_leaves_digital_silence_silent() {
        let mut host = music(seconds_needed() * 1.3, RATE, 3);
        for x in host.iter_mut().take(20_000) {
            *x = 0.0;
        }
        let a = masked(&host, -9.0, RATE);
        let b = masked(&host, -9.0, RATE);
        assert_eq!(a, b);
        // Frames wholly inside the silence get nothing. The frames at the edge of it have audio in
        // them, so only the part well inside is checked.
        assert!(a[..16_000].iter().all(|&x| x == 0.0), "the silence was marked");
        assert_ne!(a[30_000..40_000], host[30_000..40_000], "and the rest was");
    }

    #[test]
    fn masked_marking_works_at_another_rate_and_refuses_what_is_too_short() {
        let host = music(seconds_needed() * 2.2, 48_000.0, 5);
        let out = masked(&host, -6.0, 48_000.0);
        assert_eq!(detect(&out, 48_000.0, KEY).unwrap().status, Status::Verified);
        let mut short = vec![0.1f32; 1000];
        assert_eq!(
            embed_level_in_place(&mut short, &payload(), KEY, RATE, -6.0, Level::Masked),
            Err(SpreadError::TooShort),
        );
    }

    #[test]
    fn a_phrase_makes_the_same_key_as_the_javascript_one() {
        // FNV-1a 64 of "a" is a published vector, and the JavaScript side pins the same one.
        assert_eq!(key_from_text(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(key_from_text(b""), DEFAULT_KEY);
        assert_ne!(key_from_text(b"a phrase"), key_from_text(b"a phrasf"));
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

    fn stereo(seconds: f64) -> (Vec<f32>, Vec<f32>) {
        (music(seconds, RATE, 11), music(seconds, RATE, 12))
    }

    fn planar(left: &[f32], right: &[f32]) -> Vec<f32> {
        left.iter().chain(right).copied().collect()
    }

    fn marked_stereo() -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let (l, r) = stereo(seconds_needed() * 2.2);
        let out = embed_planar(&planar(&l, &r), 2, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        let n = l.len();
        (out[..n].to_vec(), out[n..].to_vec(), planar(&l, &r))
    }

    #[test]
    fn a_stereo_track_is_marked_and_read_back() {
        let (l, r, _) = marked_stereo();
        let found = detect_planar(&planar(&l, &r), 2, RATE, KEY).unwrap();
        assert_eq!(found.status, Status::Verified, "{found:?}");
        assert_eq!(found.frame, payload());
    }

    #[test]
    fn each_channel_alone_carries_the_whole_mark() {
        let (l, r, _) = marked_stereo();
        assert_eq!(detect(&l, RATE, KEY).unwrap().status, Status::Verified, "left");
        assert_eq!(detect(&r, RATE, KEY).unwrap().status, Status::Verified, "right");
    }

    #[test]
    fn a_fold_to_mono_keeps_the_mark() {
        // The attack the brief names. The carriers add in phase, so the fold is read as easily as
        // either channel, where independent marks per channel could have partly cancelled.
        let (l, r, _) = marked_stereo();
        let mono = attack::stereo_to_mono(&l, &r);
        assert_eq!(detect(&mono, RATE, KEY).unwrap().status, Status::Verified);
    }

    #[test]
    fn a_silent_channel_stays_silent_and_the_other_still_reads() {
        let (l, _) = stereo(seconds_needed() * 2.2);
        let silent = vec![0.0f32; l.len()];
        let out = embed_planar(&planar(&l, &silent), 2, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        let (ml, mr) = out.split_at(l.len());
        assert!(mr.iter().all(|&x| x == 0.0), "the silent channel was marked");
        assert_ne!(ml, &l[..]);
        assert_eq!(detect_planar(&out, 2, RATE, KEY).unwrap().status, Status::Verified);
    }

    #[test]
    fn an_inverted_channel_does_not_cancel_the_mark() {
        // A host whose channels are in antiphase folds to silence, which would take a mark that
        // lived in the host's own mid with it. This one is in each channel's own level, so it does
        // not.
        let (l, _) = stereo(seconds_needed() * 2.2);
        let inverted: Vec<f32> = l.iter().map(|&x| -x).collect();
        let out = embed_planar(&planar(&l, &inverted), 2, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        assert_eq!(detect_planar(&out, 2, RATE, KEY).unwrap().status, Status::Verified);
    }

    #[test]
    fn unmarked_stereo_is_never_reported_as_marked() {
        for seed in 1..=3 {
            let l = music(seconds_needed() * 1.5, RATE, seed);
            let r = music(seconds_needed() * 1.5, RATE, seed + 50);
            let found = detect_planar(&planar(&l, &r), 2, RATE, KEY).unwrap();
            assert_eq!(found.status, Status::NoMark, "seed {seed}: {found:?}");
        }
    }

    #[test]
    fn one_channel_through_the_planar_path_matches_the_mono_path() {
        let host = music(seconds_needed() * 1.2, RATE, 4);
        let a = embed(&host, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        let b = embed_planar(&host, 1, &payload(), KEY, RATE, DEFAULT_STRENGTH_DB).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_bad_channel_layout_is_refused() {
        let host = music(5.0, RATE, 1);
        let p = payload();
        assert_eq!(embed_planar(&host, 0, &p, KEY, RATE, -20.0), Err(SpreadError::BadChannels));
        assert_eq!(embed_planar(&host, MAX_CHANNELS + 1, &p, KEY, RATE, -20.0), Err(SpreadError::BadChannels));
        // A count that is not a whole number of frames is a buffer that was not planar.
        assert_eq!(embed_planar(&host[..1001], 2, &p, KEY, RATE, -20.0), Err(SpreadError::BadChannels));
        assert_eq!(detect_planar(&host[..1001], 2, RATE, KEY), Err(SpreadError::BadChannels));
        assert_eq!(detect_planar(&host, 0, RATE, KEY), Err(SpreadError::BadChannels));
    }

    #[test]
    fn audio_beyond_the_memory_bound_is_refused_not_truncated() {
        // Tested on the lengths alone, so this does not allocate what it refuses.
        assert_eq!(embed_frames(MAX_EMBED_FRAMES, 1), Ok(MAX_EMBED_FRAMES));
        assert_eq!(embed_frames(MAX_EMBED_FRAMES + 1, 1), Err(SpreadError::TooLong));
        assert_eq!(embed_frames(2 * MAX_EMBED_FRAMES, 2), Ok(MAX_EMBED_FRAMES));
        assert_eq!(embed_frames(2 * MAX_EMBED_FRAMES + 2, 2), Err(SpreadError::TooLong));
    }

    // The embedder as it was before it streamed: whole vectors for the carrier, the resampled
    // carrier, the band-limited host and the level. Kept so that streaming is checked against what it
    // replaced, bit for bit, rather than against itself.
    /// The host's level in the carrier's band, per sample.
    ///
    /// Block RMS, smoothed over three blocks, interpolated linearly between block centres so the
    /// mark's level changes smoothly rather than in steps, which would be audible as a click train.
    fn host_level_reference(samples: &[f32], sample_rate: f32) -> Vec<f32> {
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

    fn embed_reference(
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
    
        let level = host_level_reference(samples, sample_rate as f32);
        let gain = 10f32.powf(strength_db as f32 / 20.0);
        Ok(samples
            .iter()
            .zip(wave.iter().zip(level.iter()))
            .map(|(&x, (&w, &l))| x + gain * l * w)
            .collect())
    }

    #[test]
    fn marking_in_place_matches_the_whole_vector_embedder_bit_for_bit() {
        for rate in [44_100.0f64, 48_000.0, 22_050.0] {
            let host = music(seconds_needed() * 1.3, rate, 5);
            let reference = embed_reference(&host, &payload(), KEY, rate, DEFAULT_STRENGTH_DB).unwrap();
            let streamed = embed(&host, &payload(), KEY, rate, DEFAULT_STRENGTH_DB).unwrap();
            assert_eq!(reference.len(), streamed.len(), "{rate} Hz");
            let differing = reference.iter().zip(&streamed).filter(|(a, b)| a != b).count();
            assert_eq!(differing, 0, "{rate} Hz: {differing} samples differ");
        }
    }

    #[test]
    fn a_refused_embed_leaves_the_audio_alone() {
        let mut host = music(5.0, RATE, 1);
        let before = host.clone();
        assert_eq!(embed_in_place(&mut host, &payload(), KEY, RATE, -20.0), Err(SpreadError::TooShort));
        assert_eq!(host, before);
        let mut planar = [before.clone(), before.clone()].concat();
        let copy = planar.clone();
        assert_eq!(embed_planar_in_place(&mut planar, 2, &payload(), KEY, RATE, -20.0), Err(SpreadError::TooShort));
        assert_eq!(planar, copy);
    }

    /// Soft values for `copies` repeats of the stream for `frame`, with noise of the given size.
    fn soft_stream(frame: &[u8], key: u64, copies: usize, noise: f32, seed: u64) -> Vec<f32> {
        let one = stream(frame, key);
        let mut state = seed | 1;
        let mut out = Vec::new();
        for _ in 0..copies {
            for &bit in &one {
                let n = ((splitmix64(&mut state) >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 2.0 * noise;
                out.push(bit * 4.0 + n);
            }
        }
        out
    }

    #[test]
    fn completing_a_candidate_never_indexes_out_of_range_however_damaged_the_header() {
        // The bug: a header damaged enough to say one length in a single copy and another once the
        // copies were combined indexed past the end of the combined values and aborted the reader.
        // This mixes copies of frames of different lengths and noise of every size, at every start
        // near a copy boundary, and only asks that nothing panics and that an answer is consistent.
        let frames: Vec<Vec<u8>> = [3usize, 22, 63, 1].iter().map(|&n| frame::encode(&vec![0x5a; n], 0)).collect();
        let mut tried = 0;
        for (i, a) in frames.iter().enumerate() {
            for (j, b) in frames.iter().enumerate() {
                for noise in [0.5f32, 4.0, 12.0, 40.0] {
                    let mut soft = soft_stream(a, KEY, 2, noise, (i * 31 + j) as u64);
                    soft.extend(soft_stream(b, KEY, 2, noise, (i * 17 + j + 5) as u64));
                    for start in [0usize, 1, 7, copy_bits(a.len()) - 3, copy_bits(a.len()), copy_bits(a.len()) + 11] {
                        for polarity in [1.0f32, -1.0] {
                            if let Some((_, frame_bytes, copies)) = complete_candidate(&soft, start, polarity, KEY) {
                                assert!(copies >= 1);
                                assert!(frame_bytes.len() >= HEADER_BYTES);
                            }
                            tried += 1;
                        }
                    }
                }
            }
        }
        assert!(tried > 500);
    }

    #[test]
    fn a_frame_in_clean_soft_values_completes_from_its_own_start() {
        // The control for the test above: it would pass trivially if `complete_candidate` never
        // returned anything.
        let f = frame::encode(b"http://example.org/", 0);
        let soft = soft_stream(&f, KEY, 3, 0.5, 9);
        let (status, bytes, copies) = complete_candidate(&soft, 0, 1.0, KEY).expect("reads");
        assert_eq!((status, bytes, copies), (Status::Verified, f, 3));
    }

    /// Soft values the way the reader produces them: `amplitude` for a bit read cleanly and noise of
    /// unit variance on top, so `amplitude` is the per-bit signal to noise in the reader's own units.
    fn gaussian_soft(frame: &[u8], key: u64, copies: usize, drop_front: usize, amplitude: f32, seed: u64) -> Vec<f32> {
        let one = stream(frame, key);
        let mut state = seed | 1;
        let mut uniform = move || (splitmix64(&mut state) >> 40) as f32 / (1u64 << 24) as f32;
        let mut out = Vec::new();
        for _ in 0..copies {
            for &bit in &one {
                // Sum of twelve uniforms minus six: close enough to a unit Gaussian.
                let n: f32 = (0..12).map(|_| uniform()).sum::<f32>() - 6.0;
                out.push(bit * amplitude + n);
            }
        }
        out.split_off(drop_front.min(out.len()))
    }

    #[test]
    fn pooling_sync_across_copies_reads_a_mark_too_faint_for_one_copys_sync_alone() {
        // Soft values of three copies, the first 37 dropped as a crop would, at a per-bit signal to
        // noise where one copy's 32-bit sync word is no louder than the false peaks around it. Three
        // copies pooled are about 3 dB better, and name the frame's length as well. The two are
        // compared over many noise draws so that this is a rate and not an anecdote.
        let f = frame::encode(b"http://danbri.org/foaf", 0);
        let trials = 30;
        let (mut single, mut pooled) = (0, 0);
        for seed in 0..trials {
            let soft = gaussian_soft(&f, KEY, 3, 37, 0.8, seed + 100);
            if read_soft(&soft, KEY, false).status == Status::Verified {
                single += 1;
            }
            let found = read_soft(&soft, KEY, true);
            if found.status == Status::Verified {
                assert_eq!(found.frame, f, "a verified read has to be the frame that went in");
                pooled += 1;
            }
        }
        assert!(pooled >= trials * 2 / 3, "pooled read {pooled} of {trials}");
        assert!(pooled > single + trials / 4, "pooled {pooled} against single-copy {single} of {trials}");
    }

    #[test]
    fn pooled_sync_finds_nothing_in_soft_values_that_carry_no_mark() {
        // The pooled search tries a thousand lengths and every offset, which is a lot of chances to
        // see a pattern in noise. The frame's checks still gate it, and this is the evidence.
        for seed in 0..40u64 {
            let mut state = seed * 7 + 1;
            let mut uniform = move || (splitmix64(&mut state) >> 40) as f32 / (1u64 << 24) as f32;
            let soft: Vec<f32> = (0..2500).map(|_| (0..12).map(|_| uniform()).sum::<f32>() - 6.0).collect();
            assert_eq!(read_soft(&soft, KEY, true).status, Status::NoMark, "seed {seed}");
        }
    }

    // The masked embedder as it was before it streamed: whole vectors of thresholds and the carrier added
    // frame by frame. Kept so that the stream is checked against what it replaced, bit for bit.
    use crate::fft::fft;
    use crate::psycho::{FrameMeter, BANDS, HOP};
    fn embed_masked_reference(
        samples: &mut [f32],
        bits: &[f32],
        period: &[f32],
        key_rate: (f64, usize),
        margin_db: f64,
    ) {
        let (sample_rate, n44) = key_rate;
        let n = samples.len();
        let mut meter = FrameMeter::new(sample_rate);
        let frames = n / HOP + 2;
        let margin = 10f64.powf(margin_db / 10.0);
    
        let frame_at = |host: &[f32], f: usize| -> [f32; FRAME] {
            let mut out = [0.0f32; FRAME];
            let start = f as isize * HOP as isize - HOP as isize;
            for (j, slot) in out.iter_mut().enumerate() {
                let i = start + j as isize;
                if i >= 0 && (i as usize) < host.len() {
                    *slot = host[i as usize];
                }
            }
            out
        };
    
        // Pass 1: thresholds, from the audio as it is.
        let mut silent = Vec::with_capacity(frames);
        let mut threshold: Vec<[f64; BANDS]> = Vec::with_capacity(frames);
        for f in 0..frames {
            let frame = frame_at(samples, f);
            silent.push(frame.iter().all(|&x| x == 0.0));
            threshold.push(meter.thresholds(&frame));
        }
        let lowest: Vec<[f64; BANDS]> = (0..frames)
            .map(|f| {
                let mut t = threshold[f];
                for g in [f.saturating_sub(1), (f + 1).min(frames - 1)] {
                    for b in 0..BANDS {
                        t[b] = t[b].min(threshold[g][b]);
                    }
                }
                t
            })
            .collect();
    
        // The carrier at the output rate, at any index. Past the end of the 44.1 kHz stream it is silence.
        let carrier_44 = |i: usize| bits[(i / CHIPS) % bits.len()] * period[i % CHIPS];
        let resampler = if (sample_rate - RATE).abs() < 1e-9 { None } else { resample::Resampler::new(n44, RATE, sample_rate) };
        let carrier_out = |i: usize| -> f32 {
            match &resampler {
                None => carrier_44(i),
                Some(r) if i < r.out_len() => r.sample_at(i, &carrier_44),
                Some(_) => 0.0,
            }
        };
    
        let sine: Vec<f64> = (0..FRAME).map(|j| ((j as f64 + 0.5) * std::f64::consts::PI / FRAME as f64).sin()).collect();
        let edges = psycho::band_edges();
        let centres: Vec<f64> = (0..BANDS).map(|b| (edges[b] + edges[b + 1]) / 2.0).collect();
        let (mut re, mut im) = (vec![0.0f64; FRAME], vec![0.0f64; FRAME]);
    
        // Pass 2: the shaped carrier, added in place.
        for f in 0..frames {
            if silent[f] {
                continue;
            }
            let start = f as isize * HOP as isize - HOP as isize;
            let mut c = [0.0f32; FRAME];
            for (j, slot) in c.iter_mut().enumerate() {
                let i = start + j as isize;
                if i >= 0 && (i as usize) < n {
                    *slot = carrier_out(i as usize);
                }
            }
            let own = meter.energy(&c);
            // Gain per band as a power ratio in dB, where the carrier has anything in the band to scale.
            let gain_db: Vec<Option<f64>> = (0..BANDS)
                .map(|b| {
                    if own[b] > 1e-30 {
                        Some(10.0 * (lowest[f][b] * margin / own[b]).log10())
                    } else {
                        None
                    }
                })
                .collect();
            let valid: Vec<usize> = (0..BANDS).filter(|&b| gain_db[b].is_some()).collect();
            if valid.is_empty() {
                continue;
            }
            // `gain_db` is a power ratio in dB, so the amplitude gain is ten to the power of a twentieth of it.
            let amplitude = |hz: f64| -> f64 {
                let at = valid.partition_point(|&b| centres[b] < hz);
                let db = if at == 0 {
                    gain_db[valid[0]].unwrap()
                } else if at == valid.len() {
                    gain_db[valid[valid.len() - 1]].unwrap()
                } else {
                    let (lo, hi) = (valid[at - 1], valid[at]);
                    let t = (hz - centres[lo]) / (centres[hi] - centres[lo]);
                    gain_db[lo].unwrap() * (1.0 - t) + gain_db[hi].unwrap() * t
                };
                10f64.powf(db / 20.0)
            };
    
            for j in 0..FRAME {
                re[j] = c[j] as f64 * sine[j];
                im[j] = 0.0;
            }
            fft(&mut re, &mut im, false);
            for k in 0..=FRAME / 2 {
                let g = amplitude(k as f64 * meter.bin_hz);
                re[k] *= g;
                im[k] *= g;
                if k > 0 && k < FRAME / 2 {
                    re[FRAME - k] *= g;
                    im[FRAME - k] *= g;
                }
            }
            fft(&mut re, &mut im, true);
            for j in 0..FRAME {
                let i = start + j as isize;
                if i >= 0 && (i as usize) < n {
                    samples[i as usize] += (re[j] * sine[j]) as f32;
                }
            }
        }
    }
    

    fn bits_and_period(key: u64) -> (Vec<f32>, Vec<f32>) {
        (stream(&payload(), key), carrier(key))
    }

    #[test]
    fn the_stream_matches_the_whole_file_embedder_bit_for_bit_away_from_the_end() {
        for rate in [44_100.0f64, 48_000.0] {
            let host = music(seconds_needed() * 1.3, rate, 5);
            let (bits, period) = bits_and_period(KEY);
            let n44 = ((host.len() as f64) * RATE / rate).ceil() as usize;
            let mut reference = host.clone();
            embed_masked_reference(&mut reference, &bits, &period, (rate, n44), -6.0);
            let mut streamed = host.clone();
            embed_masked_in_place(&mut streamed, &bits, &period, (rate, n44), -6.0);
            // The reference stops the carrier at the end of the file and clamps the last frame's
            // neighbours; the stream carries on and is followed by silence. Only the last three hops differ.
            let safe = host.len() - 3 * HOP;
            let differing = (0..safe).filter(|&i| reference[i] != streamed[i]).count();
            assert_eq!(differing, 0, "{rate} Hz: {differing} of {safe} samples differ");
            assert_ne!(streamed[safe..], host[safe..], "and the tail is still marked");
        }
    }

    #[test]
    fn the_stream_gives_the_same_bits_whatever_the_block_size() {
        let host = music(seconds_needed() * 1.1, RATE, 9);
        let (bits, period) = bits_and_period(KEY);
        let run = |sizes: &[usize]| -> Vec<f32> {
            let mut s = mark_stream::MaskedStream::new(bits.clone(), period.clone(), RATE, -6.0, 1, 0).unwrap();
            let mut out = Vec::new();
            let mut at = 0usize;
            let mut which = 0usize;
            while at < host.len() {
                let len = sizes[which % sizes.len()].min(host.len() - at);
                let mut block = vec![0.0f32; len];
                s.process_channel(0, &host[at..at + len], &mut block);
                out.extend(block);
                at += len;
                which += 1;
            }
            out
        };
        let whole = run(&[host.len()]);
        for sizes in [vec![1usize], vec![7], vec![64], vec![480], vec![1024], vec![4096], vec![1, 100, 3, 1023, 1025, 17]] {
            assert_eq!(run(&sizes), whole, "block sizes {sizes:?}");
        }
    }

    #[test]
    fn the_latency_is_exactly_what_it_is_reported_to_be() {
        // With the mark turned right down, a sample comes out where it went in, `LATENCY` later.
        let host = music(5.0, RATE, 2);
        let (bits, period) = bits_and_period(KEY);
        let mut s = mark_stream::MaskedStream::new(bits, period, RATE, -200.0, 1, 0).unwrap();
        let mut out = vec![0.0f32; host.len()];
        s.process_channel(0, &host, &mut out);
        assert!(out[..mark_stream::LATENCY].iter().all(|&v| v == 0.0), "silence before the first sample");
        let worst = (mark_stream::LATENCY..host.len())
            .map(|t| (out[t] - host[t - mark_stream::LATENCY]).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-6, "output is the input delayed by {} samples, to {worst}", mark_stream::LATENCY);
    }

    #[test]
    fn a_stream_started_part_way_along_the_timeline_gives_the_same_mark_for_the_same_position() {
        // The carrier is a function of position. A stream that begins `offset` samples in, fed the same audio,
        // marks each sample with what that position gets in a stream that began at zero, wherever the
        // position is a whole number of hops from the start so the frames line up.
        let host = music(seconds_needed() * 1.2, RATE, 4);
        let (bits, period) = bits_and_period(KEY);
        let offset = 50 * HOP;
        let mut a = mark_stream::MaskedStream::new(bits.clone(), period.clone(), RATE, -6.0, 1, 0).unwrap();
        let mut b = mark_stream::MaskedStream::new(bits, period, RATE, -6.0, 1, offset as u64).unwrap();
        // `a` sees silence for `offset` samples and then the audio, so at the audio's start it is where `b` begins.
        let silence = vec![0.0f32; offset];
        let mut sink = vec![0.0f32; offset];
        a.process_channel(0, &silence, &mut sink);
        let mut out_a = vec![0.0f32; host.len()];
        let mut out_b = vec![0.0f32; host.len()];
        a.process_channel(0, &host, &mut out_a);
        b.process_channel(0, &host, &mut out_b);
        // `a` has silence before the audio and `b` has not, so the first audio frame's lowest-of-three threshold
        // differs (`a` has a silent neighbour and `b` has no past). That reaches the first two hops of audio,
        // which come out `LATENCY` later.
        let from = mark_stream::LATENCY + 3 * HOP;
        assert_eq!(out_a[from..], out_b[from..]);
    }

    #[test]
    fn the_allocation_counter_counts() {
        // The positive control for the test below: a counter that always reads zero would pass it.
        let before = crate::alloc_count::reset();
        let v: Vec<u8> = Vec::with_capacity(1000);
        std::hint::black_box(&v);
        assert!(crate::alloc_count::get() > before);
    }

    #[test]
    fn the_stream_allocates_nothing_while_it_runs() {
        // Real-time safety as a count rather than a claim: the global allocator is wrapped for the tests and
        // counts what the thread asks of it between two points.
        let host = music(4.0, RATE, 3);
        let (bits, period) = bits_and_period(KEY);
        let mut s = mark_stream::MaskedStream::new(bits, period, RATE, -6.0, 2, 0).unwrap();
        let mut out = vec![0.0f32; 1000];
        // Warm up so that nothing lazy is counted, then count.
        s.process_channel(0, &host[..4000], &mut vec![0.0f32; 4000]);
        let before = crate::alloc_count::reset();
        for chunk in host[4000..60_000].chunks(1000) {
            s.process_channel(0, chunk, &mut out[..chunk.len()]);
            s.process_channel(1, chunk, &mut out[..chunk.len()]);
        }
        assert_eq!(crate::alloc_count::get() - before, 0, "allocations while processing");
    }
}
