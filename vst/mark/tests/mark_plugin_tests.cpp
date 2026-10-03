// vst/mark/tests/mark_plugin_tests.cpp
//
// The DPF wrapper, driven through DPF's own PluginExporter, which is what every plugin format uses to talk to a
// plugin. That makes this the nearest thing to a host that runs without one: parameters, state, activation, latency,
// and run() with the buffer shapes a host uses, including in place. It checks the wrapper maps host calls to the
// engine and nothing more; what the engine does is checked in mark_engine_tests.cpp, and neither replaces a
// person loading the bundle in a DAW.

#include "DistrhoPluginInternal.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

extern "C" {
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

int read(const std::vector<float>& l, const std::vector<float>& r, std::size_t from, const std::string& key, std::vector<uint8_t>& frame) {
    uint32_t lo = 0, hi = 0;
    core_key_from_text(reinterpret_cast<const uint8_t*>(key.data()), static_cast<uint32_t>(key.size()), &lo, &hi);
    const std::size_t len = l.size() - from;
    float* planar = core_buffer_new(static_cast<uint32_t>(len * 2));
    float* data = core_buffer_data(planar);
    std::memcpy(data, l.data() + from, len * sizeof(float));
    std::memcpy(data + len, r.data() + from, len * sizeof(float));
    core_buffer_set_len(planar, static_cast<uint32_t>(len * 2));
    float* sink = core_buffer_new(70000);
    double c = 0, sp = 0;
    const int status = core_ss_detect(planar, 44100.0, lo, hi, 2, sink, &c, &sp);
    const uint8_t* bytes = reinterpret_cast<const uint8_t*>(core_buffer_data(sink));
    frame.assign(bytes, bytes + 64);
    core_buffer_free(planar);
    core_buffer_free(sink);
    return status;
}
}  // namespace

int main() {
    using namespace DISTRHO;
    std::printf("mark plugin tests (through DPF's PluginExporter)\n");

    d_nextBufferSize = 512;
    d_nextSampleRate = 44100.0;
    d_nextPluginIsDummy = false;
    d_nextCanRequestParameterValueChanges = false;

    PluginExporter plugin(nullptr, nullptr, nullptr, nullptr);
    expect(plugin.isActive() == false, "a new plugin is not active");
    expect(plugin.getLatency() == 3072, "it reports the engine's latency to the host");
    expect(plugin.getParameterCount() == 2, "two parameters, margin and bypass");
    expect(plugin.getStateCount() == 2, "two states, identifier and key");
    expect(std::fabs(plugin.getParameterValue(0) - (-6.0f)) < 1e-6f, "the margin starts at -6 dB");
    expect(plugin.getParameterValue(1) == 0.0f, "and bypass is off");

    const std::string id = "urn:x:plugin-test";
    plugin.setState("identifier", id.c_str());
    plugin.setState("key", "wrapper key");
    expect(std::string(plugin.getStateValue("identifier")) == id, "the identifier round trips through state");
    expect(std::string(plugin.getStateValue("key")) == "wrapper key", "and so does the key");
    plugin.setState("not-a-state", "x");
    expect(std::string(plugin.getStateValue("not-a-state")).empty(), "an unknown state is ignored");

    plugin.setParameterValue(0, -9.0f);
    expect(std::fabs(plugin.getParameterValue(0) - (-9.0f)) < 1e-6f, "the margin moves");
    plugin.setParameterValue(0, 40.0f);
    expect(plugin.getParameterValue(0) <= 0.0f, "and is clamped to a sensible range (the engine refuses above 0)");
    plugin.setParameterValue(0, -6.0f);

    plugin.activate();
    expect(plugin.isActive(), "activate makes it active");

    // 40 seconds of music-shaped stereo, run in place in blocks of mixed sizes, as a host that edits in place does.
    const std::size_t total = 40 * 44100;
    std::vector<float> left(total), right(total);
    unsigned state = 99;
    for (std::size_t i = 0; i < total; ++i) {
        state = state * 1664525u + 1013904223u;
        const float noise = (static_cast<float>(state >> 8) / 16777216.0f - 0.5f) * 0.04f;
        const float t = static_cast<float>(i) / 44100.0f;
        const float env = 0.5f + 0.5f * std::sin(2.0f * 3.14159265f * 0.4f * t);
        left[i] = env * 0.25f * std::sin(2.0f * 3.14159265f * 220.0f * t) + noise;
        right[i] = env * 0.25f * std::sin(2.0f * 3.14159265f * 277.0f * t) - noise;
    }
    const std::vector<float> inL = left, inR = right;
    std::size_t at = 0, which = 0;
    const uint32_t sizes[] = {512, 256, 64, 512, 480};
    while (at < total) {
        const uint32_t n = static_cast<uint32_t>(std::min<std::size_t>(sizes[which++ % 5], total - at));
        const float* in[2] = {left.data() + at, right.data() + at};
        float* out[2] = {left.data() + at, right.data() + at};  // the same buffers
        plugin.run(in, out, n);
        at += n;
    }

    std::vector<uint8_t> frame;
    const int status = read(left, right, 3072, "wrapper key", frame);
    expect(status == 0, "the core's reader verifies a mark written through the wrapper, in place");
    uint8_t want[10 + 32];
    const int32_t wantLen = core_frame_encode(reinterpret_cast<const uint8_t*>(id.data()), static_cast<uint32_t>(id.size()), 0, want, sizeof want);
    expect(wantLen > 0 && std::memcmp(frame.data(), want, static_cast<std::size_t>(wantLen)) == 0, "and it carries the identifier that was set");

    plugin.deactivate();
    expect(!plugin.isActive(), "deactivate makes it inactive");
    plugin.activate();
    expect(plugin.isActive() && std::string(plugin.getStateValue("identifier")) == id, "it can be reactivated and keeps its state");

    // Bypass through the parameter: the output is then the input, delayed.
    plugin.setParameterValue(1, 1.0f);
    std::vector<float> sl(20000), sr(20000), ol(20000), orr(20000);
    for (std::size_t i = 0; i < sl.size(); ++i) { sl[i] = 0.3f * std::sin(0.05f * static_cast<float>(i)); sr[i] = sl[i]; }
    // Enough blocks for the slew to settle, then compare the tail.
    std::size_t pos = 0;
    while (pos < sl.size()) {
        const uint32_t n = static_cast<uint32_t>(std::min<std::size_t>(512, sl.size() - pos));
        const float* in[2] = {sl.data() + pos, sr.data() + pos};
        float* out[2] = {ol.data() + pos, orr.data() + pos};
        plugin.run(in, out, n);
        pos += n;
    }
    float worst = 0.f;
    for (std::size_t i = 12000; i < sl.size(); ++i) worst = std::max(worst, std::fabs(ol[i] - sl[i - 3072]));
    expect(worst < 1e-3f, "a bypassed plugin outputs the input delayed by its reported latency");

    if (failures > 0) {
        std::printf("mark plugin tests: %d failure(s)\n", failures);
        return 1;
    }
    std::printf("mark plugin tests: passed\n");
    return 0;
}
