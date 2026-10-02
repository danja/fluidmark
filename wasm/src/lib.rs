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

pub mod codec;
pub mod dsp;
pub mod pitch;
pub mod roundtrip;
pub mod signal;
pub mod tables;

use std::alloc::Layout;

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