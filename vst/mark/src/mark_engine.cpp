// vst/mark/src/mark_engine.cpp

#include "fluidmark/mark_engine.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>

// The Rust core's C ABI (docs/ffi.md). Written by hand, as in wasm/tests/link_check.cpp, and the link check is
// what keeps these honest.
extern "C" {
uint32_t core_mark_latency();
void* core_mark_create(const uint8_t* frame, uint32_t frame_len, uint32_t key_lo, uint32_t key_hi, double sample_rate,
                       double margin_db, uint32_t channels, uint64_t pos0);
int32_t core_mark_process(void* handle, const float* const* inputs, float* const* outputs, uint32_t frames);
int32_t core_mark_set_margin(void* handle, double margin_db);
int32_t core_mark_set_position(void* handle, uint64_t position);
int32_t core_mark_destroy(void* handle);
int32_t core_frame_encode(const uint8_t* payload, uint32_t len, uint8_t flags, uint8_t* out, uint32_t cap);
int32_t core_key_from_text(const uint8_t* text, uint32_t len, uint32_t* lo, uint32_t* hi);
}

namespace fluidmark {

namespace {
constexpr uint32_t kCrossfade = 512;     // samples over which a new stream replaces the old
constexpr float kBypassSlew = 1.0f / 256.0f;
constexpr uint64_t kPollMs = 20;

std::string trimmed(const std::string& s) {
    const auto first = s.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = s.find_last_not_of(" \t\r\n");
    return s.substr(first, last - first + 1);
}
}  // namespace

uint32_t MarkEngine::latencySamples() { return core_mark_latency(); }

MarkEngine::MarkEngine() { worker_ = std::thread([this] { workerLoop(); }); }

MarkEngine::~MarkEngine() {
    running_.store(false);
    if (worker_.joinable()) worker_.join();
    destroy(active_);
    destroy(incoming_);
    destroy(ready_.exchange(nullptr));
    for (auto& slot : retired_) destroy(slot.exchange(nullptr));
}

void MarkEngine::destroy(Stream* s) {
    if (s == nullptr) return;
    if (s->handle != nullptr) core_mark_destroy(s->handle);
    delete s;
}

MarkEngine::Stream* MarkEngine::build(const MarkSettings& s, uint64_t position) const {
    auto* stream = new Stream();
    const std::string identifier = trimmed(s.identifier);
    if (identifier.empty() || identifier.size() > kMaxIdentifierBytes) return stream;  // no mark

    uint8_t frame[10 + kMaxIdentifierBytes + 8];
    const int32_t frameLen = core_frame_encode(reinterpret_cast<const uint8_t*>(identifier.data()),
                                               static_cast<uint32_t>(identifier.size()), 0, frame, sizeof frame);
    if (frameLen < 0) return stream;
    uint32_t lo = 0, hi = 0;
    if (core_key_from_text(reinterpret_cast<const uint8_t*>(s.key.data()), static_cast<uint32_t>(s.key.size()), &lo, &hi) != 0) return stream;
    stream->handle = core_mark_create(frame, static_cast<uint32_t>(frameLen), lo, hi, sampleRate_, s.marginDb, channels_, position);
    return stream;
}

void MarkEngine::prepare(double sampleRate, uint32_t channels, uint32_t maxBlock) {
    sampleRate_ = sampleRate;
    channels_ = channels;
    maxBlock_ = std::max<uint32_t>(maxBlock, 1);

    destroy(active_);
    destroy(incoming_);
    destroy(ready_.exchange(nullptr));
    incoming_ = nullptr;

    wetA_.assign(channels, std::vector<float>(maxBlock_, 0.0f));
    wetB_.assign(channels, std::vector<float>(maxBlock_, 0.0f));
    dry_.assign(channels, std::vector<float>(latencySamples(), 0.0f));
    ptrA_.resize(channels);
    ptrB_.resize(channels);
    for (uint32_t c = 0; c < channels; ++c) {
        ptrA_[c] = wetA_[c].data();
        ptrB_[c] = wetB_[c].data();
    }
    dryAt_ = 0;

    MarkSettings s;
    {
        std::lock_guard<std::mutex> lock(settingsMutex_);
        s = settings_;
        built_ = generation_.load();
    }
    appliedMargin_ = std::clamp(s.marginDb, kMinMarginDb, kMaxMarginDb);
    s.marginDb = appliedMargin_;
    active_ = build(s, 0);
    incomingFed_ = 0;
    crossfade_ = 0;
    expected_ = 0;
    positioned_ = false;
    marked_ = 0;
    bypassMix_ = s.bypass ? 1.0f : 0.0f;
    marking_.store(active_->handle != nullptr && !s.bypass);
    prepared_ = true;
    workerWanted_.store(true);
}

void MarkEngine::configure(const MarkSettings& settings) {
    MarkSettings s = settings;
    s.marginDb = std::clamp(s.marginDb, kMinMarginDb, kMaxMarginDb);
    {
        std::lock_guard<std::mutex> lock(settingsMutex_);
        const bool rebuild = s.identifier != settings_.identifier || s.key != settings_.key;
        settings_ = s;
        if (rebuild) generation_.fetch_add(1);
    }
    margin_.store(s.marginDb);
    bypass_.store(s.bypass);
    identifierBytes_.store(static_cast<uint32_t>(trimmed(s.identifier).size()));
}

MarkSettings MarkEngine::settings() const {
    std::lock_guard<std::mutex> lock(settingsMutex_);
    return settings_;
}

double MarkEngine::copySeconds() const {
    // One copy is 32 sync bits and two coded parts of 2 * (8n + 6) bits, each bit 2048 samples at 44.1 kHz, where
    // the frame is a 10 byte header and the payload. The same arithmetic as `copy_bits` in the core, kept as a
    // readout and nothing else.
    const double n = static_cast<double>(identifierBytes_.load());
    const double bits = 32.0 + 2.0 * (8.0 * 10.0 + 6.0) + 2.0 * (8.0 * n + 6.0);
    return bits * 2048.0 / 44100.0;
}

bool MarkEngine::waitUntilBuilt(uint32_t timeoutMs) const {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    while (std::chrono::steady_clock::now() < deadline) {
        if (ready_.load(std::memory_order_acquire) != nullptr) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return false;
}

double MarkEngine::secondsMarked() const { return sampleRate_ > 0 ? static_cast<double>(marked_) / sampleRate_ : 0.0; }

void MarkEngine::retire(Stream* s) {
    const std::size_t head = retireHead_.load(std::memory_order_relaxed);
    Stream* expected = nullptr;
    // A slot is free when it is null. If every slot is somehow taken the stream is leaked rather than freed here,
    // which would be a lock on the audio thread; the worker keeps up, so this is a bound and not an expectation.
    if (retired_[head % kRetired].compare_exchange_strong(expected, s, std::memory_order_release)) {
        retireHead_.store(head + 1, std::memory_order_relaxed);
    }
}

void MarkEngine::workerLoop() {
    while (running_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(kPollMs));
        // Free what the audio thread is finished with.
        for (auto& slot : retired_) {
            Stream* s = slot.exchange(nullptr, std::memory_order_acquire);
            if (s != nullptr) destroy(s);
        }
        if (!workerWanted_.load()) continue;
        MarkSettings s;
        uint64_t generation;
        {
            std::lock_guard<std::mutex> lock(settingsMutex_);
            generation = generation_.load();
            if (generation == built_) continue;
            s = settings_;
        }
        // Built with position zero: the audio thread says where it really is when it adopts the stream.
        Stream* next = build(s, 0);
        {
            std::lock_guard<std::mutex> lock(settingsMutex_);
            built_ = generation;
        }
        Stream* stale = ready_.exchange(next, std::memory_order_acq_rel);
        if (stale != nullptr) destroy(stale);
    }
}

void MarkEngine::process(const float* const* in, float* const* out, uint32_t frames, const Transport& transport) {
    if (!prepared_ || channels_ == 0) {
        for (uint32_t c = 0; c < channels_; ++c)
            if (in[c] != out[c]) std::memcpy(out[c], in[c], frames * sizeof(float));
        return;
    }
    const uint32_t latency = latencySamples();
    uint32_t done = 0;
    // A host may hand over more than it said it would; take it in pieces the scratch can hold.
    while (done < frames) {
        const uint32_t n = std::min(frames - done, maxBlock_);
        const float* inp[16];
        float* outp[16];
        for (uint32_t c = 0; c < channels_; ++c) {
            inp[c] = in[c] + done;
            outp[c] = out[c] + done;
        }

        // Follow the host's timeline when it says where it is: a seek or a loop is a jump in position.
        if (transport.frame >= 0) {
            const int64_t position = transport.frame + done;
            if (!positioned_ || position != expected_) {
                if (active_ != nullptr && active_->handle != nullptr) core_mark_set_position(active_->handle, static_cast<uint64_t>(position));
                if (incoming_ != nullptr && incoming_->handle != nullptr) core_mark_set_position(incoming_->handle, static_cast<uint64_t>(position));
                positioned_ = true;
            }
            expected_ = position + n;
        } else {
            expected_ += n;
        }

        // A finished replacement stream is taken up here, told where it is, and primed for a crossfade.
        if (incoming_ == nullptr) {
            Stream* next = ready_.exchange(nullptr, std::memory_order_acq_rel);
            if (next != nullptr) {
                incoming_ = next;
                incomingFed_ = 0;
                crossfade_ = 0;
                if (incoming_->handle != nullptr) {
                    core_mark_set_position(incoming_->handle, static_cast<uint64_t>(std::max<int64_t>(expected_ - static_cast<int64_t>(n), 0)));
                    core_mark_set_margin(incoming_->handle, appliedMargin_);
                }
            }
        }

        // The margin moves at the next frame, and the overlap of the core's windows is the crossfade.
        const double margin = margin_.load(std::memory_order_relaxed);
        if (margin != appliedMargin_) {
            appliedMargin_ = margin;
            if (active_ != nullptr && active_->handle != nullptr) core_mark_set_margin(active_->handle, margin);
            if (incoming_ != nullptr && incoming_->handle != nullptr) core_mark_set_margin(incoming_->handle, margin);
        }

        // Each stream marks and delays the input by the latency. A stream with no mark is the dry signal, delayed,
        // which is also what bypass mixes toward; the ring below is read before it is written, so its delay is
        // exactly `latency` samples.
        const bool activeMarks = active_ != nullptr && active_->handle != nullptr;
        const bool incomingMarks = incoming_ != nullptr && incoming_->handle != nullptr;
        if (activeMarks) core_mark_process(active_->handle, inp, ptrA_.data(), n);
        if (incomingMarks) core_mark_process(incoming_->handle, inp, ptrB_.data(), n);

        bool swap = false;
        const float target = bypass_.load(std::memory_order_relaxed) ? 1.0f : 0.0f;
        for (uint32_t s = 0; s < n; ++s) {
            const bool validIncoming = incoming_ != nullptr && (incomingFed_ + s >= latency);
            const float g = std::min(1.0f, static_cast<float>(crossfade_) / static_cast<float>(kCrossfade));
            const float mix = bypassMix_ + (target - bypassMix_) * kBypassSlew;
            for (uint32_t c = 0; c < channels_; ++c) {
                float& slot = dry_[c][dryAt_];
                const float dry = slot;
                slot = inp[c][s];
                const float a = activeMarks ? wetA_[c][s] : dry;
                float wet = a;
                if (validIncoming) {
                    const float b = incomingMarks ? wetB_[c][s] : dry;
                    wet = a * (1.0f - g) + b * g;
                }
                outp[c][s] = wet * (1.0f - mix) + dry * mix;
            }
            bypassMix_ = mix;
            dryAt_ = (dryAt_ + 1) % latency;
            if (validIncoming) {
                ++crossfade_;
                if (crossfade_ >= kCrossfade) swap = true;
            }
        }
        incomingFed_ += n;
        marked_ += n;
        marking_.store(activeMarks && !bypass_.load(std::memory_order_relaxed), std::memory_order_relaxed);

        if (swap) {
            retire(active_);
            active_ = incoming_;
            incoming_ = nullptr;
            crossfade_ = 0;
            incomingFed_ = 0;
        }
        done += n;
    }
}

}  // namespace fluidmark
