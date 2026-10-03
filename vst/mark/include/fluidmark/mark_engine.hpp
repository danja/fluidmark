// vst/mark/include/fluidmark/mark_engine.hpp
//
// The portable engine behind the Mark plugin: no DPF, no host types, so CTest can drive it with no DAW.
//
// It owns streams from the Rust core (`core_mark_*`, docs/ffi.md) and does the host-facing work the core does
// not: framing the identifier, deriving the key, following the host's timeline, delaying a bypassed signal by
// the same latency as a marked one, and swapping to a new identifier or key without a click or a lock.
//
// Threads. `prepare` and `configure` are for a thread that may block (a host's main thread, a test). `process`
// is the audio thread and allocates nothing, takes no lock and calls nothing that does. A worker thread builds
// the replacement stream when the identifier or key changes and frees the old one afterwards, which is why
// neither happens on the audio thread. The audio thread and the worker meet through three atomics and a ring
// of retired streams, all wait-free.

#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace fluidmark {

struct MarkSettings {
    /// What the mark carries, as UTF-8. Empty means no mark: the signal passes through, delayed.
    std::string identifier;
    /// A phrase that decides where the mark hides. Empty is the public default key, which anyone can read.
    std::string key;
    /// How many dB under the modelled masking threshold the mark sits.
    double marginDb = -6.0;
    /// A bypassed engine still delays by the latency, so toggling it moves nothing in time.
    bool bypass = false;
};

/// What the host says about where this block is on its timeline.
struct Transport {
    /// The timeline position of the first sample of the block, or -1 when the host does not say.
    int64_t frame = -1;
    bool playing = false;
};

class MarkEngine {
public:
    /// The most characters of identifier the engine accepts, matching the page and the tools.
    static constexpr std::size_t kMaxIdentifierBytes = 189;  // 63 characters of UTF-8 at its widest
    static constexpr double kMinMarginDb = -24.0;
    static constexpr double kMaxMarginDb = 0.0;

    MarkEngine();
    ~MarkEngine();
    MarkEngine(const MarkEngine&) = delete;
    MarkEngine& operator=(const MarkEngine&) = delete;

    /// The delay, in samples, between a sample going in and coming out. Report it to the host.
    static uint32_t latencySamples();

    /// Not the audio thread, and not while it is running. Sizes every buffer and builds the first stream.
    void prepare(double sampleRate, uint32_t channels, uint32_t maxBlock);

    /// Any thread that may block. Takes effect without a click: a new identifier or key is built on a worker
    /// and crossfaded in, the margin moves at the next frame, and bypass crossfades over a few milliseconds.
    void configure(const MarkSettings& settings);
    MarkSettings settings() const;

    /// The audio thread. `in` and `out` are one pointer per channel and may be the same buffers.
    void process(const float* const* in, float* const* out, uint32_t frames, const Transport& transport);

    // Readouts for a UI, safe to read from any thread.
    uint32_t identifierBytes() const { return identifierBytes_.load(std::memory_order_relaxed); }
    /// Seconds of audio one whole copy of the mark takes at the current rate and identifier.
    double copySeconds() const;
    /// Seconds of marked audio produced since `prepare`.
    double secondsMarked() const;
    /// For tests: block until the worker has built what the last `configure` asked for, or the timeout passes.
    bool waitUntilBuilt(uint32_t timeoutMs) const;

    /// True when the stream is marking, false when the identifier is empty or the plugin is bypassed.
    bool marking() const { return marking_.load(std::memory_order_relaxed); }

private:
    struct Stream {
        void* handle = nullptr;  // null means "no mark": the signal passes through.
    };

    Stream* build(const MarkSettings& s, uint64_t position) const;
    static void destroy(Stream* s);
    void workerLoop();
    void retire(Stream* s);

    // Settings, guarded for the threads that may block.
    mutable std::mutex settingsMutex_;
    MarkSettings settings_;
    std::atomic<uint64_t> generation_{0};
    uint64_t built_ = 0;  // worker only

    std::atomic<double> margin_{-6.0};
    std::atomic<bool> bypass_{false};
    std::atomic<uint32_t> identifierBytes_{0};
    std::atomic<bool> marking_{false};

    // Audio thread's.
    double sampleRate_ = 44100.0;
    uint32_t channels_ = 0;
    uint32_t maxBlock_ = 0;
    bool prepared_ = false;
    Stream* active_ = nullptr;
    Stream* incoming_ = nullptr;
    uint32_t incomingFed_ = 0;
    uint32_t crossfade_ = 0;
    int64_t expected_ = 0;
    bool positioned_ = false;
    double appliedMargin_ = -6.0;
    float bypassMix_ = 0.0f;
    uint64_t marked_ = 0;
    std::vector<std::vector<float>> wetA_, wetB_;
    std::vector<const float*> ptrIn_;
    std::vector<float*> ptrA_, ptrB_;
    std::vector<std::vector<float>> dry_;
    std::size_t dryAt_ = 0;

    // Worker to audio: a finished stream ready to adopt. Audio to worker: streams to free.
    std::atomic<Stream*> ready_{nullptr};
    static constexpr std::size_t kRetired = 16;
    std::atomic<Stream*> retired_[kRetired] = {};
    std::atomic<std::size_t> retireHead_{0};  // audio writes
    std::size_t retireTail_ = 0;              // worker reads

    std::atomic<bool> running_{true};
    std::atomic<bool> workerWanted_{false};
    std::thread worker_;
};

}  // namespace fluidmark
