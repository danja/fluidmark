// vst/mark/src/dpf/MarkUI.cpp
//
// The NanoVG UI: an identifier, a key, a margin and a bypass, and what the engine is doing, in words.
//
// NanoVG has no text widget, so the two fields are hand-made: a click focuses one, typing goes through
// onCharacterInput, and backspace, paste and the keys a host would otherwise take for transport are handled in
// onKeyboard. The keyboard handling follows downspout's Tuney VST, which met the same hosts first: VST3 sends
// Backspace as raw key code 1, and printable keys have to be claimed or the DAW treats Space as play.
//
// No meters of the audio, and no reader. The plugin embeds.

#include "DistrhoUI.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

START_NAMESPACE_DISTRHO

namespace {
constexpr uint32_t kParamMargin = 0;
constexpr uint32_t kParamBypass = 1;
constexpr const char* kKeyIdentifier = "identifier";
constexpr const char* kKeyKey = "key";
constexpr std::size_t kMaxCharacters = 63;
constexpr float kMinMargin = -24.0f;
constexpr float kMaxMargin = 0.0f;

struct Rect {
    float x, y, w, h;
    bool contains(float px, float py) const { return px >= x && px <= x + w && py >= y && py <= y + h; }
};

/// The character a key event carries, as UTF-8, or nothing for a control character.
std::string characterText(const DGL_NAMESPACE::Widget::CharacterInputEvent& ev) {
    if (ev.string[0] != '\0') {
        const unsigned char first = static_cast<unsigned char>(ev.string[0]);
        if (first < 0x20 || first == 0x7f) return {};
        return ev.string;
    }
    const uint32_t cp = ev.character;
    if (cp < 0x20 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return {};
    std::string out;
    if (cp <= 0x7f) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7ff) {
        out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    } else if (cp <= 0xffff) {
        out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    } else {
        out.push_back(static_cast<char>(0xf0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3f)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
    }
    return out;
}

std::size_t characterCount(const std::string& s) {
    std::size_t n = 0;
    for (unsigned char c : s) if ((c & 0xc0) != 0x80) ++n;
    return n;
}

void eraseLastCharacter(std::string& s) {
    while (!s.empty() && (static_cast<unsigned char>(s.back()) & 0xc0) == 0x80) s.pop_back();
    if (!s.empty()) s.pop_back();
}
}  // namespace

class MarkUI final : public UI {
public:
    MarkUI() : UI(DISTRHO_UI_DEFAULT_WIDTH, DISTRHO_UI_DEFAULT_HEIGHT) {
       #ifdef DGL_NO_SHARED_RESOURCES
        createFontFromFile("sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
       #else
        loadSharedResources();
       #endif
        const float w = static_cast<float>(getWidth());
        identifierRect_ = {24, 96, w - 48, 40};
        keyRect_ = {24, 168, w - 48, 40};
        marginRect_ = {24, 244, w - 48 - 130, 28};
        bypassRect_ = {w - 24 - 110, 238, 110, 40};
    }

protected:
    void parameterChanged(uint32_t index, float value) override {
        if (index == kParamMargin) margin_ = value;
        else if (index == kParamBypass) bypass_ = value >= 0.5f;
        repaint();
    }

    void stateChanged(const char* key, const char* value) override {
        if (key == nullptr) return;
        if (std::strcmp(key, kKeyIdentifier) == 0) identifier_ = value != nullptr ? value : "";
        else if (std::strcmp(key, kKeyKey) == 0) key_ = value != nullptr ? value : "";
        repaint();
    }

    void onNanoDisplay() override {
        const float w = static_cast<float>(getWidth());
        const float h = static_cast<float>(getHeight());
        beginPath(); rect(0, 0, w, h); fillColor(Color(18, 20, 26)); fill();

        fontSize(26); fillColor(Color(232, 236, 245)); textAlign(ALIGN_LEFT | ALIGN_MIDDLE);
        text(24, 36, "FluidMark", nullptr);
        fontSize(13); fillColor(Color(150, 160, 180));
        text(24, 62, "Put last in the chain. Embeds a watermark; it does not read one.", nullptr);

        drawField(identifierRect_, "Identifier", identifier_, focus_ == Field::Identifier, false);
        drawField(keyRect_, "Key (optional)", key_, focus_ == Field::Key, true);

        // Margin: how far under the modelled masking threshold the mark sits.
        fontSize(13); fillColor(Color(150, 160, 180)); textAlign(ALIGN_LEFT | ALIGN_BOTTOM);
        char label[96];
        std::snprintf(label, sizeof label, "Margin: %.1f dB under the masking threshold (lower is quieter)", margin_);
        text(marginRect_.x, marginRect_.y - 6, label, nullptr);
        beginPath(); roundedRect(marginRect_.x, marginRect_.y, marginRect_.w, marginRect_.h, 6); fillColor(Color(30, 34, 44)); fill();
        const float amount = (margin_ - kMinMargin) / (kMaxMargin - kMinMargin);
        beginPath(); roundedRect(marginRect_.x + 2, marginRect_.y + 2, std::max(0.0f, (marginRect_.w - 4) * amount), marginRect_.h - 4, 5);
        fillColor(Color(86, 150, 232)); fill();

        // Bypass is a labelled switch, and its state is in the words and not only the colour.
        beginPath(); roundedRect(bypassRect_.x, bypassRect_.y, bypassRect_.w, bypassRect_.h, 8);
        fillColor(bypass_ ? Color(176, 88, 70) : Color(36, 40, 52)); fill();
        fontSize(15); fillColor(Color(244, 246, 250)); textAlign(ALIGN_CENTER | ALIGN_MIDDLE);
        text(bypassRect_.x + bypassRect_.w / 2, bypassRect_.y + bypassRect_.h / 2, bypass_ ? "Bypassed" : "Marking", nullptr);

        // What it is doing, in words.
        fontSize(14); textAlign(ALIGN_LEFT | ALIGN_TOP);
        const std::size_t bytes = identifier_.size();
        if (bytes == 0) {
            fillColor(Color(232, 176, 90));
            text(24, 296, "No identifier: the signal passes through unmarked.", nullptr);
        } else {
            const double bits = 32.0 + 2.0 * (8.0 * 10.0 + 6.0) + 2.0 * (8.0 * static_cast<double>(bytes) + 6.0);
            std::snprintf(label, sizeof label, "%zu bytes. One copy of the mark takes %.0f s of audio.", bytes, bits * 2048.0 / 44100.0);
            fillColor(Color(190, 200, 218));
            text(24, 296, label, nullptr);
            fillColor(Color(150, 160, 180));
            text(24, 318, key_.empty() ? "No key: anyone can read this mark." : "Made with your key. The same phrase is needed to read it.", nullptr);
        }
    }

    bool onMouse(const MouseEvent& ev) override {
        if (ev.button != 1) return false;
        const float x = ev.pos.getX(), y = ev.pos.getY();
        if (!ev.press) { dragging_ = false; return false; }
        if (identifierRect_.contains(x, y)) { focus_ = Field::Identifier; repaint(); return true; }
        if (keyRect_.contains(x, y)) { focus_ = Field::Key; repaint(); return true; }
        if (bypassRect_.contains(x, y)) { setParam(kParamBypass, bypass_ ? 0.0f : 1.0f); focus_ = Field::None; return true; }
        if (marginRect_.contains(x, y)) { dragging_ = true; focus_ = Field::None; dragTo(x); return true; }
        focus_ = Field::None;
        repaint();
        return false;
    }

    bool onMotion(const MotionEvent& ev) override {
        if (!dragging_) return false;
        dragTo(ev.pos.getX());
        return true;
    }

    bool onCharacterInput(const CharacterInputEvent& ev) override {
        if (focus_ == Field::None) return false;
        const std::string character = characterText(ev);
        if (character.empty()) return false;
        std::string& target = focus_ == Field::Identifier ? identifier_ : key_;
        // The identifier is capped at what the page and the tools take; a longer one would need a longer track.
        if (focus_ == Field::Identifier && characterCount(target) >= kMaxCharacters) return true;
        target += character;
        push();
        return true;
    }

    bool onKeyboard(const KeyboardEvent& ev) override {
        if (focus_ == Field::None) return false;
        std::string& target = focus_ == Field::Identifier ? identifier_ : key_;
        // Steinberg VST3 uses raw virtual-key code 1 for Backspace, and hosts differ in which field they fill.
        if (ev.key == kKeyBackspace || ev.keycode == 1) {
            if (ev.press) { eraseLastCharacter(target); push(); }
            return true;
        }
        if (ev.press && (ev.key == '\t')) {
            focus_ = focus_ == Field::Identifier ? Field::Key : Field::Identifier;
            repaint();
            return true;
        }
        if (ev.press && (ev.key == '\r' || ev.key == '\n')) { focus_ = Field::None; repaint(); return true; }
        if (ev.press && (ev.mod & (kModifierControl | kModifierSuper)) != 0 && (ev.key == 'v' || ev.key == 'V')) {
            std::size_t size = 0;
            const void* data = getClipboard(size);
            if (data != nullptr && size > 0) {
                std::string pasted(static_cast<const char*>(data), size);
                pasted.erase(std::remove(pasted.begin(), pasted.end(), '\n'), pasted.end());
                pasted.erase(std::remove(pasted.begin(), pasted.end(), '\r'), pasted.end());
                target += pasted;
                while (focus_ == Field::Identifier && characterCount(target) > kMaxCharacters) eraseLastCharacter(target);
                push();
            }
            return true;
        }
        // Printable typing arrives through onCharacterInput. Claim it here as well, on press and release, so the host
        // does not take Space for transport or a letter for a shortcut while a field has the focus.
        if (ev.key >= kKeySpace && ev.key < kKeyDelete && (ev.mod & (kModifierControl | kModifierSuper)) == 0) return true;
        return false;
    }

private:
    enum class Field { None, Identifier, Key };

    void drawField(const Rect& r, const char* label, const std::string& value, bool focused, bool hide) {
        fontSize(13); fillColor(Color(150, 160, 180)); textAlign(ALIGN_LEFT | ALIGN_BOTTOM);
        text(r.x, r.y - 6, label, nullptr);
        beginPath(); roundedRect(r.x, r.y, r.w, r.h, 7);
        fillColor(focused ? Color(36, 44, 62) : Color(28, 32, 42)); fill();
        // The focus is a visible outline, since the outline and not the fill is what says where typing will go.
        if (focused) { strokeColor(Color(86, 150, 232)); strokeWidth(2.0f); stroke(); }
        fontSize(18); fillColor(Color(232, 236, 245)); textAlign(ALIGN_LEFT | ALIGN_MIDDLE);
        std::string shown = (hide && !focused) ? std::string(characterCount(value), '*') : value;
        if (focused) shown += "|";
        // NanoVG asserts on an empty string, so an empty field draws nothing rather than nothing-as-text.
        if (!shown.empty()) text(r.x + 12, r.y + r.h / 2, shown.c_str(), nullptr);
    }

    void dragTo(float x) {
        const float amount = std::clamp((x - marginRect_.x) / marginRect_.w, 0.0f, 1.0f);
        setParam(kParamMargin, std::round((kMinMargin + amount * (kMaxMargin - kMinMargin)) * 2.0f) / 2.0f);
    }

    void setParam(uint32_t index, float value) {
        editParameter(index, true);
        setParameterValue(index, value);
        editParameter(index, false);
        if (index == kParamMargin) margin_ = value; else bypass_ = value >= 0.5f;
        repaint();
    }

    void push() {
        setState(kKeyIdentifier, identifier_.c_str());
        setState(kKeyKey, key_.c_str());
        repaint();
    }

    Rect identifierRect_{}, keyRect_{}, marginRect_{}, bypassRect_{};
    std::string identifier_, key_;
    float margin_ = -6.0f;
    bool bypass_ = false;
    bool dragging_ = false;
    Field focus_ = Field::None;

    DISTRHO_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MarkUI)
};

UI* createUI() { return new MarkUI(); }

END_NAMESPACE_DISTRHO
