// vst/mark/src/dpf/MarkPlugin.cpp
//
// The DPF shell for the Mark plugin. Thin on purpose: it maps parameters and state to the engine and hands the
// host's blocks across. Everything that decides what the audio becomes is in the engine and, beneath it, the
// Rust core, which is the same code the page runs. There is no detector here, deliberately: a plugin in a
// mastering chain embeds and never extracts (docs/vst.md).

#include "DistrhoPlugin.hpp"
#include "fluidmark/mark_engine.hpp"

#include <cstring>
#include <string>

START_NAMESPACE_DISTRHO

namespace {
enum Parameters : uint32_t { kParamMargin = 0, kParamBypass, kParamCount };
enum States : uint32_t { kStateIdentifier = 0, kStateKey, kStateCount };
constexpr const char* kKeyIdentifier = "identifier";
constexpr const char* kKeyKey = "key";
}  // namespace

class MarkPlugin : public Plugin {
public:
    MarkPlugin() : Plugin(kParamCount, 0, kStateCount) {
        settings_.marginDb = -6.0;
        engine_.configure(settings_);
        setLatency(fluidmark::MarkEngine::latencySamples());
    }

protected:
    const char* getLabel() const override { return "FluidMark"; }
    const char* getDescription() const override {
        return "Embeds an inaudible-by-design watermark in the audio passing through it. Put it last in a mastering chain.";
    }
    const char* getMaker() const override { return "danja"; }
    const char* getHomePage() const override { return "https://danja.github.io/fluidmark/"; }
    const char* getLicense() const override { return "GPL-3.0-or-later"; }
    uint32_t getVersion() const override { return d_version(0, 1, 0); }
    int64_t getUniqueId() const override { return d_cconst('F', 'l', 'M', 'k'); }

    void initParameter(uint32_t index, Parameter& parameter) override {
        switch (index) {
        case kParamMargin:
            parameter.hints = kParameterIsAutomatable;
            parameter.name = "Margin";
            parameter.symbol = "margin";
            parameter.unit = "dB";
            parameter.ranges.def = -6.0f;
            parameter.ranges.min = static_cast<float>(fluidmark::MarkEngine::kMinMarginDb);
            parameter.ranges.max = static_cast<float>(fluidmark::MarkEngine::kMaxMarginDb);
            break;
        case kParamBypass:
            parameter.hints = kParameterIsAutomatable | kParameterIsBoolean;
            parameter.name = "Bypass";
            parameter.symbol = "bypass";
            parameter.ranges.def = 0.0f;
            parameter.ranges.min = 0.0f;
            parameter.ranges.max = 1.0f;
            break;
        }
    }

    void initState(uint32_t index, State& state) override {
        switch (index) {
        case kStateIdentifier:
            state.key = kKeyIdentifier;
            state.label = "Identifier";
            state.hints = 0;
            state.defaultValue = "";
            break;
        case kStateKey:
            state.key = kKeyKey;
            state.label = "Key";
            state.hints = 0;
            state.defaultValue = "";
            break;
        }
    }

    float getParameterValue(uint32_t index) const override {
        const fluidmark::MarkSettings s = engine_.settings();
        return index == kParamMargin ? static_cast<float>(s.marginDb) : (s.bypass ? 1.0f : 0.0f);
    }

    void setParameterValue(uint32_t index, float value) override {
        fluidmark::MarkSettings s = engine_.settings();
        if (index == kParamMargin) s.marginDb = value;
        else if (index == kParamBypass) s.bypass = value >= 0.5f;
        engine_.configure(s);
    }

    String getState(const char* key) const override {
        const fluidmark::MarkSettings s = engine_.settings();
        if (std::strcmp(key, kKeyIdentifier) == 0) return String(s.identifier.c_str());
        if (std::strcmp(key, kKeyKey) == 0) return String(s.key.c_str());
        return String();
    }

    void setState(const char* key, const char* value) override {
        fluidmark::MarkSettings s = engine_.settings();
        if (std::strcmp(key, kKeyIdentifier) == 0) s.identifier = value != nullptr ? value : "";
        else if (std::strcmp(key, kKeyKey) == 0) s.key = value != nullptr ? value : "";
        else return;
        engine_.configure(s);
    }

    void activate() override {
        engine_.prepare(getSampleRate(), 2, getBufferSize());
        setLatency(fluidmark::MarkEngine::latencySamples());
    }

    void sampleRateChanged(double) override {}

    void run(const float** inputs, float** outputs, uint32_t frames) override {
        fluidmark::Transport transport;
        const TimePosition& position = getTimePosition();
        transport.playing = position.playing;
        transport.frame = position.playing ? static_cast<int64_t>(position.frame) : -1;
        engine_.process(inputs, outputs, frames, transport);
    }

private:
    fluidmark::MarkEngine engine_;
    fluidmark::MarkSettings settings_;

    DISTRHO_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MarkPlugin)
};

Plugin* createPlugin() { return new MarkPlugin(); }

END_NAMESPACE_DISTRHO
