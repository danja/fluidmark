//! wasm/src/lib.rs
//!
//! The C ABI every host calls: JavaScript through Wasm, C++ by linking the static library.
//! Nothing here may be awkward to reach from C++, so the surface is C-compatible types and
//! `extern "C"` functions only. The ergonomics live in `src/*.js`, not here.
//!
//! Buffers are allocated here and handed out as pointers. A caller never chooses an offset
//! into the module's memory, and never tells the core how long a buffer is: the core keeps the
//! length in a header and writes it. That removes the whole class of bug where a length
//! disagrees with the allocation, which is a crash at best and a wrong measurement at worst.

pub mod attack;
pub mod codec;
pub mod frame;
pub mod lfs;
pub mod mark_stream;
pub mod dsp;
pub mod ecc;
pub mod estimate;
pub mod fft;
pub mod filter;
pub mod resample;
pub mod spread;
pub mod pitch;
pub mod psycho;
pub mod roundtrip;
pub mod signal;
pub mod tables;

use std::alloc::Layout;

#[cfg(test)]
pub mod alloc_count {
    //! wasm/src/alloc_count.rs (inline)
    //!
    //! A counting allocator for the tests, so that "allocates nothing while processing" is a number.
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<u64> = const { Cell::new(0) };
    }

    pub struct Counting;

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            COUNT.with(|c| c.set(c.get() + 1));
            System.alloc(layout)
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            System.dealloc(ptr, layout)
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            COUNT.with(|c| c.set(c.get() + 1));
            System.realloc(ptr, layout, new_size)
        }
    }

    /// Allocations this thread has made so far.
    pub fn get() -> u64 {
        COUNT.with(|c| c.get())
    }

    /// The count now, for taking a difference.
    pub fn reset() -> u64 {
        get()
    }
}

#[cfg(test)]
#[global_allocator]
static COUNTING: alloc_count::Counting = alloc_count::Counting;


/// Bumped whenever a signature here changes. Hosts check it at startup, because a stale
/// library linked into a rebuilt host is a crash or a wrong answer with nothing in any log.
pub const ABI_VERSION: u32 = 1;

pub const CORE_OK: i32 = 0;
pub const CORE_ERR_NULL: i32 = -1;
pub const CORE_ERR_LENGTH: i32 = -2;
pub const CORE_ERR_RANGE: i32 = -3;
pub const CORE_ERR_MAGIC: i32 = -4;

/// Marks a real allocation. A pointer that does not carry this is not ours to free.
const MAGIC: u32 = 0x464d_4b31; // "FMK1"

/// magic, len, cap, padding. 16 bytes so the f32 data that follows is 4-byte aligned.
const HEADER_BYTES: usize = 16;

#[repr(C)]
struct BufferHeader {
    magic: u32,
    len: u32,
    cap: u32,
    _pad: u32,
}

fn layout_for(cap: u32) -> Option<Layout> {
    let bytes = HEADER_BYTES.checked_add((cap as usize).checked_mul(4)?)?;
    Layout::from_size_align(bytes, 4).ok()
}

unsafe fn header_of<'a>(ptr: *const f32) -> Option<&'a mut BufferHeader> {
    if ptr.is_null() {
        return None;
    }
    let base = ptr.cast::<u8>().sub(HEADER_BYTES);
    let header = &mut *(base as *mut BufferHeader);
    if header.magic != MAGIC {
        return None;
    }
    Some(header)
}

/// The version of this ABI. A host that reads anything else should refuse to run rather than
/// guess at the layout.
const SCRATCH_BYTES: usize = 8;

/// Total bytes a scratch allocation occupies: its header plus the scratch itself.
///
/// The header lives inside the allocation, so the layout has to cover both. An earlier version
/// allocated only `SCRATCH_BYTES` and wrote a `HEADER_BYTES` header into it, which put the
/// header past the end of the allocation and over the next allocation's magic. The symptom was
/// a free reporting a corrupt header on a buffer that had just been written correctly.
fn scratch_layout(cap: u32) -> Option<Layout> {
    let bytes = HEADER_BYTES.checked_add(cap as usize)?;
    Layout::from_size_align(bytes, 8).ok()
}

/// Allocate scratch for out-parameters, in the module's own memory.
///
/// A wasm module can only read and write its own linear memory, so a caller on either side
/// has nowhere else for an out-parameter to land. Eight bytes is one `f64` or two `u32`.
#[no_mangle]
pub extern "C" fn core_scratch_new() -> *mut u8 {
    let Some(layout) = scratch_layout(SCRATCH_BYTES as u32) else {
        return std::ptr::null_mut();
    };
    unsafe {
        let base = std::alloc::alloc_zeroed(layout);
        if base.is_null() {
            return std::ptr::null_mut();
        }
        let header = base as *mut BufferHeader;
        (*header).magic = MAGIC;
        (*header).len = SCRATCH_BYTES as u32;
        (*header).cap = SCRATCH_BYTES as u32;
        (*header)._pad = 0;
        base.add(HEADER_BYTES)
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_scratch_free(ptr: *mut u8) -> i32 {
    if ptr.is_null() {
        return CORE_ERR_NULL;
    }
    let base = ptr.sub(HEADER_BYTES);
    let header = &mut *(base as *mut BufferHeader);
    if header.magic != MAGIC {
        return CORE_ERR_MAGIC;
    }
    let Some(layout) = scratch_layout(header.cap) else {
        return CORE_ERR_MAGIC;
    };
    std::alloc::dealloc(base, layout);
    CORE_OK
}

/// The version of this ABI. A host that reads anything else should refuse to run rather than
/// guess at the layout.
#[no_mangle]
pub extern "C" fn core_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate a buffer of `cap` samples, zeroed, with a tracked length of zero.
///
/// Returns null only if `cap` is zero or the allocation fails, which for a caller is a bug
/// rather than something to recover from.
#[no_mangle]
pub extern "C" fn core_buffer_new(cap: u32) -> *mut f32 {
    if cap == 0 {
        return std::ptr::null_mut();
    }
    let Some(layout) = layout_for(cap) else {
        return std::ptr::null_mut();
    };
    unsafe {
        let base = std::alloc::alloc_zeroed(layout);
        if base.is_null() {
            return std::ptr::null_mut();
        }
        let header = base as *mut BufferHeader;
        (*header).magic = MAGIC;
        (*header).len = 0;
        (*header).cap = cap;
        (*header)._pad = 0;
        base.add(HEADER_BYTES).cast::<f32>()
    }
}

/// Free a buffer from `core_buffer_new`. Refuses a pointer we did not hand out.
#[no_mangle]
pub unsafe extern "C" fn core_buffer_free(ptr: *mut f32) -> i32 {
    if ptr.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(header) = header_of(ptr) else {
        return CORE_ERR_MAGIC;
    };
    let cap = header.cap;
    let Some(layout) = layout_for(cap) else {
        return CORE_ERR_MAGIC;
    };
    std::alloc::dealloc(ptr.cast::<u8>().sub(HEADER_BYTES), layout);
    CORE_OK
}

/// The tracked length of a buffer, through an out-parameter so that an error is reportable.
#[no_mangle]
pub unsafe extern "C" fn core_buffer_len(ptr: *const f32, out: *mut u32) -> i32 {
    if out.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(header) = header_of(ptr) else {
        return if ptr.is_null() { CORE_ERR_NULL } else { CORE_ERR_MAGIC };
    };
    *out = header.len;
    CORE_OK
}

/// The capacity the core has recorded for a buffer.
///
/// A host keeps its own copy of the capacity it asked for, and the two can disagree if
/// something has written over the header. Being able to ask the core is what makes that
/// visible rather than a silent divergence.
#[no_mangle]
pub unsafe extern "C" fn core_buffer_capacity(ptr: *const f32, out: *mut u32) -> i32 {
    if out.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(header) = header_of(ptr) else {
        return if ptr.is_null() { CORE_ERR_NULL } else { CORE_ERR_MAGIC };
    };
    *out = header.cap;
    CORE_OK
}

/// The sample data of a buffer, for a caller to read and write through directly.
///
/// This is the whole zero-copy story: JavaScript makes a typed array over this offset and
/// reads or writes samples in place, and C++ writes through the pointer. Note what it cannot
/// do: hand a wasm function an address from a JavaScript `ArrayBuffer` and have it read
/// there. A module can only read its own linear memory, so such an address is read from the
/// module's memory instead and yields garbage rather than an error.
#[no_mangle]
pub unsafe extern "C" fn core_buffer_data(ptr: *const f32) -> *mut f32 {
    if header_of(ptr).is_none() {
        return std::ptr::null_mut();
    }
    ptr as *mut f32
}

/// Set the tracked length of a buffer, after a caller has written through
/// `core_buffer_data`. Refuses more than the capacity.
///
/// The length is tracked rather than passed per call so that no two callers can disagree about
/// how long a buffer is. It can still be set to a length nobody wrote, which is why the DSP
/// entry points report a zero length as an error rather than returning zero power.
#[no_mangle]
pub unsafe extern "C" fn core_buffer_set_len(ptr: *mut f32, n: u32) -> i32 {
    let Some(header) = header_of(ptr) else {
        return if ptr.is_null() { CORE_ERR_NULL } else { CORE_ERR_MAGIC };
    };
    if n > header.cap {
        return CORE_ERR_LENGTH;
    }
    header.len = n;
    CORE_OK
}

/// Samples of output `core_encode` needs for `byte_count` bytes of payload.
///
/// The caller sizes the output buffer with this rather than guessing, and a guess that is one
/// sample short costs the whole final crop: the decoder's grid needs the second half of the
/// last tone, and without it the last character is lost.
#[no_mangle]
pub extern "C" fn core_encoded_size(byte_count: u32) -> u32 {
    let chunks = codec::bytes_to_chunks(&(0..byte_count).map(|_| 0u8).collect::<Vec<u8>>()).len();
    // A chunk is two slots, and a long tone comes to one sample more than two slots because
    // `22050 * 0.048611111 * 2` truncates to 2143 rather than 2142. The extra sample has to be
    // allowed per chunk or the last chunk does not fit and the payload loses its final
    // character.
    let pad = (tables::START_PAD_DURATION * tables::SAMPLE_RATE as f64) as u32
        + (tables::END_PAD_DURATION * tables::SAMPLE_RATE as f64) as u32;
    let slot = tables::tone_slot_samples();
    (chunks as u32) * (slot * 2 + 1) + pad
}

/// Bytes of payload `core_decode` can return from `sample_count` samples.
///
/// An upper bound: two samples of output per crop, and a crop every slot.
#[no_mangle]
pub extern "C" fn core_decoded_size(sample_count: u32) -> u32 {
    let slot = tables::tone_slot_samples();
    (sample_count / slot.max(1)) + 2
}

/// Encode the payload bytes tracked in `input` into the sample buffer `output`.
///
/// `input` is a payload buffer, so its tracked length is a count of **bytes**, read through a
/// byte view. `output` is a sample buffer and its length is a count of **samples**. The two
/// element sizes differ deliberately: a JavaScript payload has to be staged in the module's own
/// memory before any export can read it, and a sample buffer is the only kind there is.
///
/// Returns `CORE_ERR_LENGTH` if `output` is too small; `core_encoded_size` is how to size it.
#[no_mangle]
pub unsafe extern "C" fn core_encode(input: *const f32, output: *mut f32) -> i32 {
    if input.is_null() || output.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(input_header) = header_of(input) else {
        return CORE_ERR_MAGIC;
    };
    let Some(output_header) = header_of(output) else {
        return CORE_ERR_MAGIC;
    };
    if input_header.len == 0 {
        return CORE_ERR_LENGTH;
    }

    // The payload buffer holds bytes, not samples. `core_buffer_set_len` counted bytes for
    // this call, so the data is read through a byte view rather than an f32 one. Which element
    // size a buffer's length is counted in is decided by the entry point that touches it, and
    // every entry point says which in its documentation.
    let bytes: Vec<u8> =
        std::slice::from_raw_parts(input as *const u8, input_header.len as usize).to_vec();
    let tones = codec::encode_bytes(&bytes);
    if tones.len() > output_header.cap as usize {
        return CORE_ERR_LENGTH;
    }
    std::ptr::copy_nonoverlapping(tones.as_ptr(), output, tones.len());
    output_header.len = tones.len() as u32;
    CORE_OK
}

/// Decode the samples tracked in `input` into the payload bytes tracked by `output`.
///
/// `input` is a sample buffer and its length counts samples; `output` is a payload buffer and
/// its length becomes a count of **bytes**. `output` is overwritten including its length, so
/// it does not need to be written first.
#[no_mangle]
pub unsafe extern "C" fn core_decode(input: *const f32, output: *mut f32) -> i32 {
    if input.is_null() || output.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(input_header) = header_of(input) else {
        return CORE_ERR_MAGIC;
    };
    let Some(output_header) = header_of(output) else {
        return CORE_ERR_MAGIC;
    };
    if input_header.len == 0 {
        return CORE_ERR_LENGTH;
    }

    let tones = std::slice::from_raw_parts(input, input_header.len as usize);
    let bytes = roundtrip::decode_tones(tones, tables::SAMPLE_RATE as f64);
    if bytes.len() > output_header.cap as usize {
        return CORE_ERR_LENGTH;
    }
    if !bytes.is_empty() {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output as *mut u8, bytes.len());
    }
    output_header.len = bytes.len() as u32;
    CORE_OK
}

/// Embed a frame into an audio buffer, in place.
///
/// `audio` holds samples and its length counts samples. `frame` holds bytes and its length counts
/// bytes. Both must already be written; this only reports success.
#[no_mangle]
pub unsafe extern "C" fn core_embed_lsb(
    audio: *mut f32,
    frame: *const f32,
    key_lo: u32,
    key_hi: u32,
) -> i32 {
    if audio.is_null() || frame.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(audio_header) = header_of(audio) else {
        return CORE_ERR_MAGIC;
    };
    let Some(frame_header) = header_of(frame) else {
        return CORE_ERR_MAGIC;
    };
    if audio_header.len == 0 || frame_header.len == 0 {
        return CORE_ERR_LENGTH;
    }
    // A frame of n bytes needs n * 8 samples, one per bit.
    let bits = (frame_header.len as usize) * 8;
    if bits > audio_header.len as usize {
        return CORE_ERR_LENGTH;
    }

    let key = ((key_hi as u64) << 32) | key_lo as u64;
    let samples = std::slice::from_raw_parts(audio, audio_header.len as usize).to_vec();
    let bytes = std::slice::from_raw_parts(frame as *const u8, frame_header.len as usize).to_vec();
    let marked = lfs::embed(&samples, &bytes, key);
    std::ptr::copy_nonoverlapping(marked.as_ptr(), audio, marked.len());
    CORE_OK
}

/// Read `frame_bytes` of frame bytes out of an audio buffer.
///
/// `frame_bytes` comes from the caller because LSB has no sync word to find the start with, so a
/// reader has to be told how much to read. The spread-spectrum scheme carries the length in the
/// stream instead, and that difference is a real limitation of this one.
#[no_mangle]
pub unsafe extern "C" fn core_extract_lsb(
    audio: *const f32,
    frame_bytes: u32,
    key_lo: u32,
    key_hi: u32,
    out: *mut f32,
) -> i32 {
    if audio.is_null() || out.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(audio_header) = header_of(audio) else {
        return CORE_ERR_MAGIC;
    };
    let Some(out_header) = header_of(out) else {
        return CORE_ERR_MAGIC;
    };
    if frame_bytes == 0 || frame_bytes > out_header.cap {
        return CORE_ERR_LENGTH;
    }

    let key = ((key_hi as u64) << 32) | key_lo as u64;
    let samples = std::slice::from_raw_parts(audio, audio_header.len as usize);
    let bytes = lfs::extract(samples, frame_bytes as usize, key);
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out as *mut u8, bytes.len());
    out_header.len = bytes.len() as u32;
    CORE_OK
}

/// Frame bytes, header included, for a payload of `payload_bytes`.
///
/// The reader needs this, because LSB has no sync word to measure against.
#[no_mangle]
pub extern "C" fn core_frame_bytes_for(payload_bytes: u32) -> u32 {
    lfs::frame_bytes_for(payload_bytes as usize) as u32
}

/// Which attack `core_attack` applies. The harness names them; nothing else does.
pub const ATTACK_GAIN_DB: u32 = 1;
pub const ATTACK_DITHER: u32 = 2;
pub const ATTACK_WHITE_NOISE: u32 = 3;
pub const ATTACK_PINK_NOISE: u32 = 4;
pub const ATTACK_LOWPASS: u32 = 5;
pub const ATTACK_HIGHPASS: u32 = 6;
pub const ATTACK_RESAMPLE: u32 = 7;
pub const ATTACK_TIME_SHIFT: u32 = 8;
pub const ATTACK_CROP_FRACTION: u32 = 9;

/// Removal attacks. Not degradation: attempts to take the mark out rather than to damage it.
///
/// Separate because they answer a different question and the two must not be confused. A mark
/// that survives transcoding but not a keyless low-bit scrub has not been made permanent; it has
/// been made hard to copy.
pub const REMOVE_SCRUB_LOW_BITS: u32 = 20;
pub const REMOVE_RANDOMISE_LOW_BITS: u32 = 21;

/// Removal of the spread-spectrum mark by estimating its carrier from the audio, with no key.
pub const REMOVE_ESTIMATE_SUBTRACT: u32 = 22;

/// Apply one attack to an audio buffer, in place.
///
/// One export rather than ten, because the harness is the only caller and a table of ids in one
/// place is easier to keep honest than a dozen signatures. `param` means something different per
/// attack: decibels for `ATTACK_GAIN_DB`, a signal-to-noise ratio in dB for the noise and dither
/// ones, hertz for the filters, a ratio for `ATTACK_RESAMPLE`, a sample count for
/// `ATTACK_TIME_SHIFT`, and a fraction of the length to drop from the front for
/// `ATTACK_CROP_FRACTION`.
///
/// `sample_rate` is passed rather than taken from `tables`, because the harness may run at any
/// rate and the filters and the resampler are meaningless without the right one.
///
/// `param2` supplies the pseudo-random seed for the ones that need one, as two 32-bit halves.
#[no_mangle]
pub unsafe extern "C" fn core_attack(
    audio: *mut f32,
    attack: u32,
    param: f64,
    sample_rate: f64,
    seed_lo: u32,
    seed_hi: u32,
) -> i32 {
    let Some(header) = header_of(audio) else {
        return CORE_ERR_MAGIC;
    };
    if header.len == 0 {
        return CORE_ERR_LENGTH;
    }
    let input = std::slice::from_raw_parts(audio, header.len as usize).to_vec();
    let seed = ((seed_hi as u64) << 32) | seed_lo as u64;

    let output = match attack {
        ATTACK_GAIN_DB => attack::gain(&input, param as f32),
        ATTACK_DITHER => attack::dither(&input, param as f32, seed),
        ATTACK_WHITE_NOISE => attack::white_noise(&input, param as f32, seed),
        ATTACK_PINK_NOISE => attack::pink_noise(&input, param as f32, seed),
        ATTACK_LOWPASS => attack::lowpass(&input, param as f32, sample_rate as f32),
        ATTACK_HIGHPASS => attack::highpass(&input, param as f32, sample_rate as f32),
        ATTACK_RESAMPLE => attack::resample(&input, param as f32, sample_rate as f32),
        ATTACK_TIME_SHIFT => attack::time_shift(&input, param as usize),
        ATTACK_CROP_FRACTION => {
            let drop = ((input.len() as f64) * param) as usize;
            attack::crop(&input, drop, input.len())
        }
        REMOVE_SCRUB_LOW_BITS => attack::scrub_low_bits(&input),
        REMOVE_RANDOMISE_LOW_BITS => attack::randomise_low_bits(&input, seed),
        REMOVE_ESTIMATE_SUBTRACT => estimate::estimate_and_subtract(&input),
        _ => return CORE_ERR_RANGE,
    };

    if output.len() > header.cap as usize {
        return CORE_ERR_LENGTH;
    }
    std::ptr::copy_nonoverlapping(output.as_ptr(), audio, output.len());
    header.len = output.len() as u32;
    CORE_OK
}

/// Goertzel power at `freq` over a buffer's tracked length, through an out-parameter.
///
/// The length is not a parameter: it is whatever `core_buffer_write` last recorded.
#[no_mangle]
pub unsafe extern "C" fn core_goertzel_power(
    ptr: *const f32,
    freq: f32,
    sample_rate: f32,
    out: *mut f64,
) -> i32 {
    if ptr.is_null() || out.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(header) = header_of(ptr) else {
        return CORE_ERR_MAGIC;
    };
    if header.len == 0 {
        return CORE_ERR_LENGTH;
    }
    if !(sample_rate > 0.0) || !(freq > 0.0) || freq >= sample_rate {
        return CORE_ERR_RANGE;
    }
    let samples = std::slice::from_raw_parts(ptr, header.len as usize);
    *out = dsp::goertzel_power(samples, freq as f64, sample_rate as f64);
    CORE_OK
}

/// `core_ss_detect` outcomes that are not errors. `CORE_OK` (0) means a frame was found and its
/// checksum matched, and these two are the other things a read can honestly say.
pub const SS_NO_MARK: i32 = 1;
pub const SS_DAMAGED: i32 = 2;

fn spread_error(e: spread::SpreadError) -> i32 {
    match e {
        spread::SpreadError::BadRate | spread::SpreadError::BadChannels => CORE_ERR_RANGE,
        spread::SpreadError::BadFrame
        | spread::SpreadError::TooShort
        | spread::SpreadError::TooLong => CORE_ERR_LENGTH,
    }
}

/// How many samples **per channel** of audio at `sample_rate` one copy of a spread-spectrum mark
/// needs for a frame of `frame_bytes`. Shorter audio is refused by `core_ss_embed`.
#[no_mangle]
pub extern "C" fn core_ss_min_samples(frame_bytes: u32, sample_rate: f64) -> u32 {
    if !(sample_rate > 0.0) {
        return 0;
    }
    let at_rate = (spread::copy_samples(frame_bytes as usize) as f64) * sample_rate / spread::RATE;
    at_rate.ceil().min(u32::MAX as f64) as u32
}

/// Mark audio with the spread-spectrum scheme, in place.
///
/// `audio` counts samples and `frame` counts bytes, and the frame is a whole frame as
/// `core_frame`-style framing produces it. `audio` is **planar**: `channels` runs of equal length,
/// one after another, so its length must be a multiple of `channels`. Every channel carries the
/// same stream; `docs/steganography.md` has the reasoning. One channel is plain mono. `strength_db` is the mark's level relative to the host
/// in the carrier's band; -20 is the default. Returns `CORE_ERR_LENGTH` for audio too short to hold
/// one copy, which `core_ss_min_samples` reports in advance.
#[no_mangle]
pub unsafe extern "C" fn core_ss_embed(
    audio: *mut f32,
    frame: *const f32,
    key_lo: u32,
    key_hi: u32,
    sample_rate: f64,
    strength_db: f64,
    channels: u32,
    mode: u32,
) -> i32 {
    if audio.is_null() || frame.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(audio_header) = header_of(audio) else {
        return CORE_ERR_MAGIC;
    };
    let Some(frame_header) = header_of(frame) else {
        return CORE_ERR_MAGIC;
    };
    if audio_header.len == 0 || frame_header.len == 0 {
        return CORE_ERR_LENGTH;
    }
    let key = ((key_hi as u64) << 32) | key_lo as u64;
    // In place: the marker needs nothing the size of the track beyond the track, and a copy here
    // would be the largest allocation in the call.
    let samples = std::slice::from_raw_parts_mut(audio, audio_header.len as usize);
    let bytes = std::slice::from_raw_parts(frame as *const u8, frame_header.len as usize);
    let level = match mode {
        0 => spread::Level::Relative,
        1 => spread::Level::Masked,
        _ => return CORE_ERR_RANGE,
    };
    match spread::embed_planar_level_in_place(samples, channels as usize, bytes, key, sample_rate, strength_db, level) {
        Ok(()) => CORE_OK,
        Err(e) => spread_error(e),
    }
}

/// Look for a spread-spectrum mark in audio, with no knowledge of where it starts.
///
/// Returns `CORE_OK` when a frame was found and verified, `SS_NO_MARK` when nothing was, and
/// `SS_DAMAGED` when a frame header was found but its checksum did not match. In the first and
/// third cases the frame bytes as read are in `out`, whose length counts bytes; in the second it
/// is zero. Only the first means anything may be believed. `confidence` receives how far the sync
/// peak stood above the noise, in standard deviations, and is zero when there was no peak. `speed`
/// receives how much longer the file was than the mark's own timing as a ratio, 1.0 unless the
/// reader had to correct for a file that had been slowed or sped up.
///
/// `audio` is planar, as for `core_ss_embed`, and what is read is the average of its channels. The
/// work is bounded: only the first `spread::MAX_ANALYSIS` frames are read.
#[no_mangle]
pub unsafe extern "C" fn core_ss_detect(
    audio: *const f32,
    sample_rate: f64,
    key_lo: u32,
    key_hi: u32,
    channels: u32,
    out: *mut f32,
    confidence: *mut f64,
    speed: *mut f64,
) -> i32 {
    if audio.is_null() || out.is_null() || confidence.is_null() || speed.is_null() {
        return CORE_ERR_NULL;
    }
    let Some(audio_header) = header_of(audio) else {
        return CORE_ERR_MAGIC;
    };
    let Some(out_header) = header_of(out) else {
        return CORE_ERR_MAGIC;
    };
    if audio_header.len == 0 {
        return CORE_ERR_LENGTH;
    }
    let key = ((key_hi as u64) << 32) | key_lo as u64;
    let samples = std::slice::from_raw_parts(audio, audio_header.len as usize);
    let found = match spread::detect_planar(samples, channels as usize, sample_rate, key) {
        Ok(found) => found,
        Err(e) => return spread_error(e),
    };
    if found.frame.len() > out_header.cap as usize {
        return CORE_ERR_LENGTH;
    }
    if !found.frame.is_empty() {
        std::ptr::copy_nonoverlapping(found.frame.as_ptr(), out as *mut u8, found.frame.len());
    }
    out_header.len = found.frame.len() as u32;
    *confidence = found.sync_sigmas;
    *speed = found.speed;
    match found.status {
        spread::Status::Verified => CORE_OK,
        spread::Status::NoMark => SS_NO_MARK,
        spread::Status::Damaged => SS_DAMAGED,
    }
}


/// How far a mark sits under what the music masks, by a simplified masking model. See `psycho.rs`
/// for what the model is and what it is not: it is an objective proxy, and a listener decides.
///
/// `original` and `marked` are sample buffers of one channel and the same length. `out` is a buffer
/// of at least eight samples that receives, as `f32`: frames judged, cells judged, mean NMR in dB, the
/// 95th percentile, the worst frame's mean in dB, that frame's position as a fraction of the file, the
/// fraction of cells over the threshold, and the fraction within 6 dB under it. Only `max_frames` frames
/// spread over the file are judged, so the cost is bounded.
///
/// Returns `CORE_OK`, `SS_NO_MARK` (1) when there was nothing to judge, such as digital silence or
/// two identical files, `CORE_ERR_RANGE` for a rate or frame count that is not positive, and
/// `CORE_ERR_LENGTH` for audio shorter than one frame or inputs of different lengths.
#[no_mangle]
pub unsafe extern "C" fn core_nmr(
    original: *const f32,
    marked: *const f32,
    sample_rate: f64,
    max_frames: u32,
    out: *mut f32,
) -> i32 {
    if original.is_null() || marked.is_null() || out.is_null() {
        return CORE_ERR_NULL;
    }
    let (Some(a), Some(b), Some(o)) = (header_of(original), header_of(marked), header_of(out)) else {
        return CORE_ERR_MAGIC;
    };
    if !(sample_rate > 0.0) || max_frames == 0 {
        return CORE_ERR_RANGE;
    }
    if (a.len as usize) < psycho::FRAME || a.len != b.len || o.cap < 8 {
        return CORE_ERR_LENGTH;
    }
    let orig = std::slice::from_raw_parts(original, a.len as usize);
    let mark = std::slice::from_raw_parts(marked, b.len as usize);
    match psycho::nmr(orig, mark, sample_rate, max_frames as usize) {
        None => SS_NO_MARK,
        Some(r) => {
            let values = [
                r.frames as f32,
                r.cells as f32,
                r.mean_db as f32,
                r.p95_db as f32,
                r.worst_frame_db as f32,
                r.worst_frame_at as f32,
                r.above_threshold as f32,
                r.above_minus_6 as f32,
            ];
            std::ptr::copy_nonoverlapping(values.as_ptr(), out, 8);
            o.len = 8;
            CORE_OK
        }
    }
}


/// A streaming embedder, for a host that feeds audio a block at a time: a plugin. See `mark_stream.rs` and
/// `docs/vst.md`.
///
/// The handle is created off the audio thread, which is where everything is allocated. `core_mark_process`
/// allocates nothing, takes no lock and cannot unwind, so it is safe to call from an audio callback.
/// Output is the input marked and delayed by `core_mark_latency()` samples, exactly.
pub struct MarkHandle {
    magic: u32,
    stream: mark_stream::MaskedStream,
}

const MARK_MAGIC: u32 = 0x464d_4d53; // "FMMS"

/// How many samples a stream delays what goes through it, to be reported to the host.
#[no_mangle]
pub extern "C" fn core_mark_latency() -> u32 {
    mark_stream::LATENCY as u32
}

/// Create a stream, or null. `frame` is a whole frame (`frame_len` bytes, header included) as `core_frame`
/// style framing produces it, and the stream takes a copy. `pos0` is the stream position of the first
/// sample: a plugin passes the host's timeline position, so that a bounce and a re-bounce agree.
///
/// Null means a rate or channel count outside what the stream works at, or a frame that is too short to be
/// one. Free the handle with `core_mark_destroy`, and not from the audio thread.
#[no_mangle]
pub unsafe extern "C" fn core_mark_create(
    frame: *const u8,
    frame_len: u32,
    key_lo: u32,
    key_hi: u32,
    sample_rate: f64,
    margin_db: f64,
    channels: u32,
    pos0: u64,
) -> *mut MarkHandle {
    if frame.is_null() || (frame_len as usize) < frame::HEADER_BYTES {
        return std::ptr::null_mut();
    }
    let key = ((key_hi as u64) << 32) | key_lo as u64;
    let bytes = std::slice::from_raw_parts(frame, frame_len as usize);
    let Some((bits, period)) = spread::stream_parts(bytes, key) else {
        return std::ptr::null_mut();
    };
    let Some(stream) = mark_stream::MaskedStream::new(bits, period, sample_rate, margin_db, channels as usize, pos0) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(MarkHandle { magic: MARK_MAGIC, stream }))
}

/// Process `frames` samples of every channel. `inputs` and `outputs` are arrays of one pointer per channel,
/// as audio hosts hand them over. The two may be the same buffers. Returns `CORE_OK`, or an error code if the
/// handle is not one of ours or a pointer is null. Real-time safe.
#[no_mangle]
pub unsafe extern "C" fn core_mark_process(
    handle: *mut MarkHandle,
    inputs: *const *const f32,
    outputs: *const *mut f32,
    frames: u32,
) -> i32 {
    if handle.is_null() || inputs.is_null() || outputs.is_null() {
        return CORE_ERR_NULL;
    }
    let h = &mut *handle;
    if h.magic != MARK_MAGIC {
        return CORE_ERR_MAGIC;
    }
    let n = frames as usize;
    for c in 0..h.stream.channels() {
        let (i, o) = (*inputs.add(c), *outputs.add(c));
        if i.is_null() || o.is_null() {
            return CORE_ERR_NULL;
        }
        if std::ptr::eq(i, o as *const f32) {
            // Processing in place: the stream reads each sample before it writes the output for it, but it
            // is a slice in and a slice out, so copy a block at a time through the stack.
            let mut block = [0.0f32; 512];
            let mut at = 0;
            while at < n {
                let len = 512.min(n - at);
                block[..len].copy_from_slice(std::slice::from_raw_parts(i.add(at), len));
                h.stream.process_channel(c, &block[..len], std::slice::from_raw_parts_mut(o.add(at), len));
                at += len;
            }
        } else {
            h.stream.process_channel(c, std::slice::from_raw_parts(i, n), std::slice::from_raw_parts_mut(o, n));
        }
    }
    CORE_OK
}

/// Move the margin, in dB under the masking threshold. Takes effect at the next frame without a step.
#[no_mangle]
pub unsafe extern "C" fn core_mark_set_margin(handle: *mut MarkHandle, margin_db: f64) -> i32 {
    if handle.is_null() {
        return CORE_ERR_NULL;
    }
    let h = &mut *handle;
    if h.magic != MARK_MAGIC {
        return CORE_ERR_MAGIC;
    }
    h.stream.set_margin_db(margin_db);
    CORE_OK
}

/// Free a stream. Not from the audio thread. A null is accepted and ignored, and a pointer that is not one of
/// ours is refused rather than freed.
#[no_mangle]
pub unsafe extern "C" fn core_mark_destroy(handle: *mut MarkHandle) -> i32 {
    if handle.is_null() {
        return CORE_OK;
    }
    if (*handle).magic != MARK_MAGIC {
        return CORE_ERR_MAGIC;
    }
    (*handle).magic = 0;
    drop(Box::from_raw(handle));
    CORE_OK
}


/// Wrap a payload in a frame (magic, version, flags, length, CRC-16), for a host that has no framing of its own.
///
/// Writes the frame to `out` and returns its length, or a negative error code: the payload may be up to 65535
/// bytes, and `out` has to hold `core_frame_bytes_for(len)`. One framing in the whole system, and this is how a
/// C++ host reaches it, so it never writes a second one.
#[no_mangle]
pub unsafe extern "C" fn core_frame_encode(payload: *const u8, len: u32, flags: u8, out: *mut u8, cap: u32) -> i32 {
    if (payload.is_null() && len > 0) || out.is_null() {
        return CORE_ERR_NULL;
    }
    if len > u16::MAX as u32 {
        return CORE_ERR_LENGTH;
    }
    let bytes = if len == 0 { &[][..] } else { std::slice::from_raw_parts(payload, len as usize) };
    let framed = frame::encode(bytes, flags);
    if framed.len() > cap as usize {
        return CORE_ERR_LENGTH;
    }
    std::ptr::copy_nonoverlapping(framed.as_ptr(), out, framed.len());
    framed.len() as i32
}


/// Say what stream position the next input sample has. Real-time safe. See `MaskedStream::set_position`.
#[no_mangle]
pub unsafe extern "C" fn core_mark_set_position(handle: *mut MarkHandle, position: u64) -> i32 {
    if handle.is_null() {
        return CORE_ERR_NULL;
    }
    let h = &mut *handle;
    if h.magic != MARK_MAGIC {
        return CORE_ERR_MAGIC;
    }
    h.stream.set_position(position);
    CORE_OK
}

/// A 64-bit key from text, as two 32-bit halves. Empty text is the public default key. The one derivation:
/// the page's `keyFromText` is held equal to it by a test.
#[no_mangle]
pub unsafe extern "C" fn core_key_from_text(text: *const u8, len: u32, lo: *mut u32, hi: *mut u32) -> i32 {
    if (text.is_null() && len > 0) || lo.is_null() || hi.is_null() {
        return CORE_ERR_NULL;
    }
    let bytes = if len == 0 { &[][..] } else { std::slice::from_raw_parts(text, len as usize) };
    let key = spread::key_from_text(bytes);
    *lo = key as u32;
    *hi = (key >> 32) as u32;
    CORE_OK
}
