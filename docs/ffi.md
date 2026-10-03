# The FFI boundary

How Rust reaches C++ and JavaScript. Decided: a plain `extern "C"` ABI, with the Rust crate
emitting **both** a `staticlib` for the native hosts and a Wasm module for the browser and
Node tools. No embedded Wasm runtime, no component model.

The reasoning is short enough to state here: one crate, one interface, and the C++ hosts link
it natively.

## Why not the alternatives

**An embedded Wasm runtime in the plugin** would put a Wasm runtime and a second language
boundary inside a VST3 bundle, to reach code that could be linked directly. The gain is
sandboxing, which this project does not want: a plugin that traps is a plugin that breaks the
DAW, and the sandbox is not protecting the plugin from anything it does not already control.

**The component model** gives typed interfaces without manual memory management, which is
real. But it needs a WIT file, a codegen step and a binding layer, and it would need a C++
component runtime in the bundle. Its main benefit is least relevant here: a DSP core passes
`f32` buffers, where explicit pointers and explicit lengths are wanted anyway, and a zero-copy
view across the boundary is the point.

**Two implementations, one per language**, is the option that is not on the table. It was
rejected in `TODO.md` under "Decisions taken" and it is the reason the boundary is fixed now
rather than later.

## What was verified

Checked on this machine before writing it down, because a boundary design that has never been
exercised is a guess.

One crate with `crate-type = ["cdylib", "staticlib", "rlib"]` produced both `libcore.a` and
`libcore.so` from one source. A C++ program linked the `.a` and called an `extern "C"` Goertzel
function; it returned 121550633 at 440 Hz against 0 at 1000 Hz on a 440 Hz sine. The same three
symbols, with identical signatures, were called from Node against the `wasm32-unknown-unknown`
build and matched a JavaScript reference to eight decimal places (65015.37).

So the interface is the same either way, and the difference is only how the host obtains the
symbol: by linking, or by instantiating.

## The shape

```
Cargo.toml
  [lib]
  crate-type = ["cdylib", "staticlib", "rlib"]   # .wasm, .a, and .so
  [profile.release]
  panic = "abort"

wasm/src/lib.rs        extern "C" surface, the only thing a host may call
wasm/src/dsp/...       internal modules, never called across the boundary
src/*.js               the JavaScript wrapper, which is where the ergonomics live
src/wasm.d.ts          types for that wrapper
```

The `.a` and the `.wasm` come from the same `extern "C"` functions. There is no second
implementation and no adapter layer between them.

## Rules

**`panic = "abort"` in release.** A Rust panic must not cross into C++ or JavaScript. The
`extern "C"` functions abort on unwind rather than propagating, and with optimisation the
caller is C++ code that has no idea a Rust unwinder exists. The release profile makes that
explicit rather than incidental.

**C-compatible types only in the boundary.** `f32`, `f64`, `u32`, `i32`, `i64`, `u64`, `bool`
as `u32`, raw pointers, and `extern "C"` functions. No `String`, no `Vec` by value, no `&str`,
no enums with data, no Rust traits across the line. Those belong behind the boundary.

**The core allocates, the caller passes the pointer back.** `core_buffer_new(len) -> *mut f32`,
`core_goertzel(ptr, len, hz)`, `core_buffer_free(ptr)`. A caller must never invent an offset
into the module's memory, and the core must never assume an offset it did not hand out.

**A null check is not validation.** `if ptr.is_null() { return 0.0 }` does not protect against
a bad address, and it silently converts a legitimate one into a zero result. This was measured
during the work above: a guard written exactly as above made a valid call at address 0 return
zero while the same call without the guard returned the correct power. Check the length against
what was allocated, and keep a handle rather than a bare pointer wherever there is state.

**State lives behind an opaque handle.** A DAW can instantiate a plugin more than once, so
there is no global state and no `static mut`. `core_encoder_new() -> *mut CoreEncoder`, with
`core_encoder_free`, and the handle is the only identifier.

**Version the ABI.** `core_abi_version() -> u32`, and a host checks it at startup. A stale `.a`
linked into a rebuilt plugin is otherwise a crash or a silent wrong answer with nothing in any
log, which is the worst combination available.

**Errors return a code, not a panic.** `core_result` or a negative return, plus an out-pointer
for a message if one is needed. The caller is C++ and cannot catch anything.

## JavaScript ergonomics

The raw boundary is deliberately unfriendly, because it has to be reachable from C++. All the
nicety lives in `src/`, the JavaScript wrapper: typed arrays instead of pointers, a codec object
instead of `new`/`free` pairs, and the shared memory buffer managed once per call.

The `.d.ts` describes the wrapper, not the raw exports. Host code should never be calling
`core_*` functions directly; if it is, a piece of the ergonomics layer has been bypassed.

## What the plugin stage inherits

The plugin links `libfluidmark_core.a` and calls the same functions the browser calls. Nothing
in the plugin needs to know about Wasm, and nothing in the core needs to know it is being used
by a plugin. That is the whole point of the decision: the plugin arrived late and cost nothing
to accommodate, because the boundary was fixed for the browser and simply already existed.

### The streaming embedder, which is what the plugin calls

Written 2026-10-03 for `docs/vst.md`. Everything else in the boundary is a call that takes a whole buffer; this is the
one that is a stream, for a host that hands over blocks.

```c
uint32_t core_mark_latency(void);          // samples between a sample going in and coming out marked: 3072
void*    core_mark_create(const uint8_t* frame, uint32_t frame_len, uint32_t key_lo, uint32_t key_hi,
                          double sample_rate, double margin_db, uint32_t channels, uint64_t pos0);
int32_t  core_mark_process(void* handle, const float* const* inputs, float* const* outputs, uint32_t frames);
int32_t  core_mark_set_margin(void* handle, double margin_db);
int32_t  core_mark_destroy(void* handle);
int32_t  core_frame_encode(const uint8_t* payload, uint32_t len, uint8_t flags, uint8_t* out, uint32_t cap);
```

- **Who allocates and who frees.** `core_mark_create` allocates everything the stream will ever need, and
  `core_mark_destroy` frees it; both are for a thread that may block, not the audio thread. The handle is the stream's
  owner, opaque, and carries a magic number so a pointer that is not one of ours is refused instead of freed.
- **`core_mark_process` is real-time safe**: no allocation (counted in the test, with a positive control for the
  counter), no lock, no panic (`panic = "abort"` and errors return codes). `inputs` and `outputs` are arrays of one
  pointer per channel, as hosts hand them over, and the two may be the same buffers.
- **Position, not block index.** The carrier at a sample is a function of its stream position, which begins at `pos0`.
  A host passes its timeline position, and a bounce, a second bounce and any block size render the same mark.
- **Framing is the core's.** `core_frame_encode` is how a C++ host makes the frame the stream takes, so there is one
  framing in the whole system and the plugin never writes a second.
- The margin moves at the next frame, and the overlap of the frames' windows is the crossfade, so the level never steps.
  A new identifier or key has to wait for a copy boundary and is not here yet: `docs/vst.md`, milestone 3.

`wasm/tests/link_check.cpp` drives all of it as a plugin would: frames a payload through the core, makes a two-channel
stream, pushes 40 seconds of audio through in blocks of seven different sizes, moves the margin, reads the result with
`core_ss_detect`, and requires the frame that went in.
