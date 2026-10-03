// vst/mark/tests/mark_engine_tests.cpp
//
// The engine behind the Mark plugin, driven the way a host drives it and checked with the core's own reader,
// with no DAW and no DPF. Plain checks in the style of wasm/tests/link_check.cpp.
//
// The allocation counts are real: the link line wraps malloc and friends, so allocations made by the Rust core
// are counted along with this program's own. The count is thread-local, so only the audio thread's is read.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "fluidmark/mark_engine.hpp"

// ---- Counting the audio thread's allocations ------------------------------------------------------------

static thread_local uint64_t gAllocations = 0;

extern "C" {
void* __real_malloc(size_t);
void* __real_calloc(size_t, size_t);
void* __real_realloc(void*, size_t);
int __real_posix_memalign(void**, size_t, size_t);
void* __real_aligned_alloc(size_t, size_t);
void* __wrap_malloc(size_t n) { ++gAllocations; return __real_malloc(n); }
void* __wrap_calloc(size_t a, size_t b) { ++gAllocations; return __real_calloc(a, b); }
void* __wrap_realloc(void* p, size_t n) { ++gAllocations; return __real_realloc(p, n); }
int __wrap_posix_memalign(void** p, size_t a, size_t n) { ++gAllocations; return __real_posix_memalign(p, a, n); }
void* __wrap_aligned_alloc(size_t a, size_t n) { ++gAllocations; return __real_aligned_alloc(a, n); }

// The core's reader and framing, for checking what the engine wrote.
float* core_buffer_new(uint32_t cap);
int32_t core_buffer_free(float* ptr);
float* core_buffer_data(const float* ptr);
int32_t core_buffer_set_len(float* ptr, uint32_t len);
int32_t core_frame_encode(const uint8_t* payload, uint32_t len, uint8_t flags, uint8_t* out, uint32_t cap);
int32_t core_key_from_text(const uint8_t* text, uint32_t len, uint32_t* lo, uint32_t* hi);
int32_t core_ss_detect(const float* audio, double sample_rate, uint32_t key_lo, uint32_t key_hi, uint32_t channels,
                       float* out, double* confidence, double* speed);
}

namespace {

int failures = 0;
void expect(bool ok, const std::string& what) {
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", what.c_str());
    if (!ok) ++failures;
}

constexpr double kRate = 44100.0;

struct Audio {
    std::vector<float> left, right;
};

/// Something music-shaped and not a tone: two chords with a slow envelope, a little noise, different left and right.
Audio makeAudio(double seconds, unsigned seed) {
    const std::size_t n = static_cast<std::size_t>(seconds * kRate);
    Audio a{std::vector<float>(n), std::vector<float>(n)};
    unsigned state = seed;
    for (std::size_t i = 0; i < n; ++i) {
        state = state * 1664525u + 1013904223u;
        const float noise = (static_cast<float>(state >> 8) / 16777216.0f - 0.5f) * 0.04f;
        const float t = static_cast<float>(i) / static_cast<float>(kRate);
        const float env = 0.5f + 0.5f * std::sin(2.0f * 3.14159265f * 0.37f * t);
        a.left[i] = env * (0.25f * std::sin(2.0f * 3.14159265f * 196.0f * t) + 0.1f * std::sin(2.0f * 3.14159265f * 784.0f * t)) + noise;
        a.right[i] = env * (0.25f * std::sin(2.0f * 3.14159265f * 247.0f * t) + 0.1f * std::sin(2.0f * 3.14159265f * 988.0f * t)) - noise;
    }
    return a;
}

/// Run `in` through an engine in blocks of the given sizes, with the timeline following along.
Audio run(fluidmark::MarkEngine& engine, const Audio& in, const std::vector<uint32_t>& sizes, bool timeline = true,
          uint64_t* audioThreadAllocations = nullptr) {
    Audio out{std::vector<float>(in.left.size()), std::vector<float>(in.left.size())};
    std::size_t at = 0, which = 0;
    while (at < in.left.size()) {
        const uint32_t n = static_cast<uint32_t>(std::min<std::size_t>(sizes[which++ % sizes.size()], in.left.size() - at));
        const float* inp[2] = {in.left.data() + at, in.right.data() + at};
        float* outp[2] = {out.left.data() + at, out.right.data() + at};
        fluidmark::Transport t;
        if (timeline) { t.frame = static_cast<int64_t>(at); t.playing = true; }
        const uint64_t before = gAllocations;
        engine.process(inp, outp, n, t);
        if (audioThreadAllocations) *audioThreadAllocations += gAllocations - before;
        at += n;
    }
    return out;
}

/// Read marked audio, from `from` to `to` samples after discarding the latency, with the core's reader. Returns
/// the status (0 verified, 1 none, 2 damaged) and the frame bytes it saw.
int readBack(const Audio& marked, std::size_t from, std::size_t to, const std::string& key, std::vector<uint8_t>& frame) {
    uint32_t lo = 0, hi = 0;
    core_key_from_text(reinterpret_cast<const uint8_t*>(key.data()), static_cast<uint32_t>(key.size()), &lo, &hi);
    const std::size_t len = to - from;
    float* planar = core_buffer_new(static_cast<uint32_t>(len * 2));
    float* data = core_buffer_data(planar);
    std::memcpy(data, marked.left.data() + from, len * sizeof(float));
    std::memcpy(data + len, marked.right.data() + from, len * sizeof(float));
    core_buffer_set_len(planar, static_cast<uint32_t>(len * 2));
    float* sink = core_buffer_new(70000);
    double confidence = 0, speed = 0;
    const int status = core_ss_detect(planar, kRate, lo, hi, 2, sink, &confidence, &speed);
    frame.clear();
    if (status == 0 || status == 2) {
        // The core writes frame bytes into the buffer and records its length; copy out what a frame needs.
        const uint8_t* bytes = reinterpret_cast<const uint8_t*>(core_buffer_data(sink));
        frame.assign(bytes, bytes + 10 + 64);
    }
    core_buffer_free(planar);
    core_buffer_free(sink);
    return status;
}

std::vector<uint8_t> frameFor(const std::string& text) {
    std::vector<uint8_t> out(10 + text.size());
    const int32_t n = core_frame_encode(reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size()), 0, out.data(), static_cast<uint32_t>(out.size()));
    out.resize(n > 0 ? static_cast<std::size_t>(n) : 0);
    return out;
}

bool startsWith(const std::vector<uint8_t>& got, const std::vector<uint8_t>& want) {
    return got.size() >= want.size() && std::equal(want.begin(), want.end(), got.begin());
}

}  // namespace

int main() {
    using fluidmark::MarkEngine;
    using fluidmark::MarkSettings;
    const uint32_t latency = MarkEngine::latencySamples();
    std::printf("mark engine tests (latency %u samples)\n", latency);
    expect(latency == 3072, "the latency is the arithmetic in docs/vst.md");

    // ---- Unmarked signal passes through, delayed -------------------------------------------------------
    {
        std::printf(" a signal with no identifier\n");
        MarkEngine e;
        e.prepare(kRate, 2, 4096);
        const Audio in = makeAudio(2.0, 1);
        const Audio out = run(e, in, {512});
        double worst = 0.0;
        bool silentFirst = true;
        for (std::size_t t = 0; t < in.left.size(); ++t) {
            if (t < latency) silentFirst = silentFirst && out.left[t] == 0.0f;
            else worst = std::max<double>(worst, std::fabs(out.left[t] - in.left[t - latency]));
        }
        expect(silentFirst, "silence for the first `latency` samples");
        expect(worst == 0.0, "then the input, exactly, delayed by the latency");
        expect(!e.marking(), "and it says it is not marking");
    }

    // ---- A mark that the core's reader verifies ---------------------------------------------------------
    const std::string idA = "urn:x:engine-test-A";
    {
        std::printf(" marking\n");
        MarkEngine e;
        MarkSettings s;
        s.identifier = idA;
        s.key = "a test phrase";
        e.configure(s);
        e.prepare(kRate, 2, 4096);
        const Audio in = makeAudio(40.0, 2);
        const Audio out = run(e, in, {64, 480, 1024, 333, 4096, 17, 2048});
        std::vector<uint8_t> frame;
        const int status = readBack(out, latency, out.left.size(), s.key, frame);
        expect(status == 0, "the core's reader verifies the mark the engine wrote");
        expect(startsWith(frame, frameFor(idA)), "and it is the frame that went in");
        expect(readBack(out, latency, out.left.size(), "another phrase", frame) != 0, "and the wrong key does not read it");
        expect(e.marking(), "the engine says it is marking");
        expect(std::fabs(e.copySeconds() - 26.4) < 8.0, "a copy is of the order the page says");
    }

    // ---- Same bits whatever the block size --------------------------------------------------------------
    {
        std::printf(" block sizes\n");
        MarkSettings s;
        s.identifier = idA;
        const Audio in = makeAudio(8.0, 3);
        Audio reference;
        bool allEqual = true;
        bool first = true;
        for (const std::vector<uint32_t>& sizes : {std::vector<uint32_t>{4096}, {1}, {7}, {64}, {480}, {1024}, {333, 100, 2000, 17}}) {
            MarkEngine e;
            e.configure(s);
            e.prepare(kRate, 2, 4096);
            const Audio out = run(e, in, sizes);
            if (first) { reference = out; first = false; }
            else allEqual = allEqual && out.left == reference.left && out.right == reference.right;
        }
        expect(allEqual, "every block size gives the same bits, from one sample to 4096");
    }

    // ---- A new identifier is crossfaded in and the audio thread allocates nothing -------------------------
    {
        std::printf(" a new identifier\n");
        const std::string idB = "urn:x:engine-test-B";
        MarkEngine e;
        MarkSettings s;
        s.identifier = idA;
        s.key = "k";
        e.configure(s);
        e.prepare(kRate, 2, 4096);
        const Audio in = makeAudio(110.0, 4);
        const std::size_t half = static_cast<std::size_t>(50.0 * kRate);

        Audio first{{in.left.begin(), in.left.begin() + half}, {in.right.begin(), in.right.begin() + half}};
        Audio second{{in.left.begin() + half, in.left.end()}, {in.right.begin() + half, in.right.end()}};

        uint64_t allocations = 0;
        Audio out1 = run(e, first, {1024, 480, 4096}, true, &allocations);
        // Warm: the first blocks may touch lazily-initialised state, and what matters is steady state. Counted now.
        s.identifier = idB;
        e.configure(s);
        const bool built = e.waitUntilBuilt(5000);
        expect(built, "the worker built the replacement stream");
        // The second half carries on the timeline from where the first stopped.
        Audio out2{std::vector<float>(second.left.size()), std::vector<float>(second.left.size())};
        {
            std::size_t at = 0, which = 0;
            const std::vector<uint32_t> sizes{1024, 480, 4096};
            while (at < second.left.size()) {
                const uint32_t n = static_cast<uint32_t>(std::min<std::size_t>(sizes[which++ % sizes.size()], second.left.size() - at));
                const float* inp[2] = {second.left.data() + at, second.right.data() + at};
                float* outp[2] = {out2.left.data() + at, out2.right.data() + at};
                fluidmark::Transport t;
                t.frame = static_cast<int64_t>(half + at);
                t.playing = true;
                const uint64_t before = gAllocations;
                e.process(inp, outp, n, t);
                allocations += gAllocations - before;
                at += n;
            }
        }
        Audio all{out1.left, out1.right};
        all.left.insert(all.left.end(), out2.left.begin(), out2.left.end());
        all.right.insert(all.right.end(), out2.right.begin(), out2.right.end());

        std::vector<uint8_t> frame;
        expect(readBack(all, latency, static_cast<std::size_t>(45.0 * kRate), "k", frame) == 0 && startsWith(frame, frameFor(idA)),
               "the start of the audio reads as the first identifier");
        expect(readBack(all, all.left.size() - static_cast<std::size_t>(45.0 * kRate), all.left.size(), "k", frame) == 0 && startsWith(frame, frameFor(idB)),
               "the end reads as the second");
        expect(allocations == 0, "the audio thread allocated nothing, through the swap (" + std::to_string(allocations) + ")");

        // No click at the swap. What the engine adds is the mark, which is the output less the input delayed by the
        // latency. Its largest sample-to-sample change in the stretch where the old stream gives way to the new is no
        // bigger than elsewhere in the same file, to within a modest factor, so the swap is not a step in the mark.
        auto markStep = [&](std::size_t from, std::size_t len) {
            float worst = 0.f;
            for (std::size_t i = from + 1; i < from + len; ++i) {
                const float a0 = all.left[i] - in.left[i - latency];
                const float a1 = all.left[i - 1] - in.left[i - 1 - latency];
                worst = std::max(worst, std::fabs(a0 - a1));
            }
            return worst;
        };
        const std::size_t swapAt = half + latency;
        const float atSwap = markStep(swapAt, 8192);
        const float elsewhere = std::max(markStep(static_cast<std::size_t>(20.0 * kRate), 8192), markStep(static_cast<std::size_t>(80.0 * kRate), 8192));
        expect(atSwap < elsewhere * 1.5f, "no step in the mark at the swap (" + std::to_string(atSwap) + " against " + std::to_string(elsewhere) + ")");
    }

    // ---- The rates a DAW project uses ---------------------------------------------------------------------
    for (const double rate : {48000.0, 88200.0, 96000.0}) {
        std::printf(" at %.0f Hz\n", rate);
        MarkEngine e;
        MarkSettings s;
        s.identifier = idA;
        s.key = "k";
        e.configure(s);
        e.prepare(rate, 2, 1024);
        const std::size_t n = static_cast<std::size_t>(40.0 * rate);
        Audio in{std::vector<float>(n), std::vector<float>(n)};
        unsigned state = 7;
        for (std::size_t i = 0; i < n; ++i) {
            state = state * 1664525u + 1013904223u;
            const float noise = (static_cast<float>(state >> 8) / 16777216.0f - 0.5f) * 0.04f;
            const float t = static_cast<float>(i) / static_cast<float>(rate);
            const float env = 0.5f + 0.5f * std::sin(2.0f * 3.14159265f * 0.37f * t);
            in.left[i] = env * 0.25f * std::sin(2.0f * 3.14159265f * 196.0f * t) + noise;
            in.right[i] = env * 0.25f * std::sin(2.0f * 3.14159265f * 247.0f * t) - noise;
        }
        const Audio out = run(e, in, {1024, 333, 480});
        // Read it back at the rate it was written, with the core's reader.
        uint32_t lo = 0, hi = 0;
        core_key_from_text(reinterpret_cast<const uint8_t*>("k"), 1, &lo, &hi);
        const std::size_t len = n - latency;
        float* planar = core_buffer_new(static_cast<uint32_t>(len * 2));
        float* data = core_buffer_data(planar);
        std::memcpy(data, out.left.data() + latency, len * sizeof(float));
        std::memcpy(data + len, out.right.data() + latency, len * sizeof(float));
        core_buffer_set_len(planar, static_cast<uint32_t>(len * 2));
        float* sink = core_buffer_new(70000);
        double confidence = 0, speed = 0;
        const int status = core_ss_detect(planar, rate, lo, hi, 2, sink, &confidence, &speed);
        std::vector<uint8_t> frame(reinterpret_cast<const uint8_t*>(core_buffer_data(sink)), reinterpret_cast<const uint8_t*>(core_buffer_data(sink)) + 64);
        expect(status == 0 && startsWith(frame, frameFor(idA)), "the mark the engine writes at this rate reads back");
        core_buffer_free(planar);
        core_buffer_free(sink);
    }

    // ---- Bypass crossfades and then is the dry signal ---------------------------------------------------
    {
        std::printf(" bypass\n");
        MarkEngine e;
        MarkSettings s;
        s.identifier = idA;
        e.configure(s);
        e.prepare(kRate, 2, 4096);
        const Audio in = makeAudio(3.0, 5);
        s.bypass = true;
        e.configure(s);
        const Audio out = run(e, in, {256});
        double settled = 0.0;
        for (std::size_t t = latency + 4096; t < in.left.size(); ++t) settled = std::max<double>(settled, std::fabs(out.left[t] - in.left[t - latency]));
        expect(settled < 1e-3, "a bypassed engine outputs the input, delayed by the latency, once it has settled");
        float maxStep = 0.f;
        for (std::size_t i = latency + 1; i < out.left.size(); ++i) maxStep = std::max(maxStep, std::fabs(out.left[i] - out.left[i - 1]));
        expect(maxStep < 0.1f, "and the way in is smooth");
    }

    // ---- A seek on the timeline -----------------------------------------------------------------------------
    {
        std::printf(" a seek\n");
        MarkEngine e;
        MarkSettings s;
        s.identifier = idA;
        s.key = "k";
        e.configure(s);
        e.prepare(kRate, 2, 4096);
        const Audio in = makeAudio(60.0, 6);
        Audio out{std::vector<float>(in.left.size()), std::vector<float>(in.left.size())};
        std::size_t at = 0;
        bool finite = true;
        while (at < in.left.size()) {
            const uint32_t n = static_cast<uint32_t>(std::min<std::size_t>(1000, in.left.size() - at));
            const float* inp[2] = {in.left.data() + at, in.right.data() + at};
            float* outp[2] = {out.left.data() + at, out.right.data() + at};
            fluidmark::Transport t;
            // A loop: the host jumps back by an odd number of samples halfway through, once.
            const int64_t pos = at < in.left.size() / 2 ? static_cast<int64_t>(at) : static_cast<int64_t>(at) - 123457;
            t.frame = std::max<int64_t>(pos, 0);
            t.playing = true;
            e.process(inp, outp, n, t);
            at += n;
        }
        for (float v : out.left) finite = finite && std::isfinite(v);
        expect(finite, "the output stays finite across a jump in position");
        std::vector<uint8_t> frame;
        expect(readBack(out, latency, in.left.size() / 2, "k", frame) == 0, "and the part before the jump still reads");
    }

    if (failures > 0) {
        std::printf("mark engine tests: %d failure(s)\n", failures);
        return 1;
    }
    std::printf("mark engine tests: passed\n");
    return 0;
}
