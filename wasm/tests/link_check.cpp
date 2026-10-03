// wasm/tests/link_check.cpp
//
// Checks that a C++ host can link the static library and call it the way the browser does.
//
// Exists because docs/ffi.md promises the C++ hosts get the same DSP from the same source, and
// a promise nothing exercises is a sentence rather than a guard. Compiled and run by
// `npm run test:native`.
//
// Note the declarations below are written by hand, which is the friction this file also
// documents: getting one wrong is silent. It went wrong the first time, with `core_buffer_data`
// declared as returning `int32_t` when it returns a pointer, and the program segfaulted rather
// than failing to compile. There is a TODO for generating this header from the Rust
// declarations; until then, this file is the only place the C++ signatures are written down,
// so it is also the thing to fix when the ABI changes.

#include <cstdint>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <vector>
#include <algorithm>

extern "C" {
uint32_t core_abi_version();
uint8_t* core_scratch_new();
int32_t core_scratch_free(uint8_t* ptr);
float* core_buffer_new(uint32_t cap);
int32_t core_buffer_free(float* ptr);
float* core_buffer_data(const float* ptr);
int32_t core_buffer_set_len(float* ptr, uint32_t len);
int32_t core_buffer_len(const float* ptr, uint32_t* out);
int32_t core_goertzel_power(const float* ptr, float freq, float sample_rate, double* out);
int32_t core_frame_encode(const uint8_t* payload, uint32_t len, uint8_t flags, uint8_t* out, uint32_t cap);
uint32_t core_frame_bytes_for(uint32_t payload_bytes);
uint32_t core_mark_latency();
void* core_mark_create(const uint8_t* frame, uint32_t frame_len, uint32_t key_lo, uint32_t key_hi,
                       double sample_rate, double margin_db, uint32_t channels, uint64_t pos0);
int32_t core_mark_process(void* handle, const float* const* inputs, float* const* outputs, uint32_t frames);
int32_t core_mark_set_margin(void* handle, double margin_db);
int32_t core_mark_destroy(void* handle);
int32_t core_ss_detect(const float* audio, double sample_rate, uint32_t key_lo, uint32_t key_hi, uint32_t channels,
                       float* out, double* confidence, double* speed);
}

namespace {
constexpr float kRate = 44100.0f;
constexpr uint32_t kSamples = 44100;
constexpr uint32_t kExpectedAbi = 1;

int failures = 0;

void expect(bool condition, const char* what) {
  if (!condition) {
    std::printf("  FAIL  %s\n", what);
    failures += 1;
  } else {
    std::printf("  ok    %s\n", what);
  }
}
}  // namespace

int main() {
  std::printf("native link check (C++ against libfluidmark_core.a)\n");

  expect(core_abi_version() == kExpectedAbi, "ABI version matches what the wrapper expects");

  float* buffer = core_buffer_new(kSamples);
  expect(buffer != nullptr, "core_buffer_new allocated a buffer");

  float* data = core_buffer_data(buffer);
  expect(data != nullptr, "core_buffer_data returned the sample area");

  for (uint32_t i = 0; i < kSamples; i++) {
    data[i] = 0.5f * std::sin(2.0f * 3.14159265358979f * 440.0f * i / kRate);
  }
  expect(core_buffer_set_len(buffer, kSamples) == 0, "core_buffer_set_len accepted the length");
  expect(core_buffer_set_len(buffer, kSamples + 1) < 0, "core_buffer_set_len refused one past the end");

  uint32_t length = 0;
  expect(core_buffer_len(buffer, &length) == 0, "core_buffer_len reported no error");
  expect(length == kSamples, "core_buffer_len agrees with the length just set");

  uint8_t* scratch = core_scratch_new();
  expect(scratch != nullptr, "core_scratch_new allocated scratch");

  double* out = reinterpret_cast<double*>(scratch);
  int32_t rc = core_goertzel_power(buffer, 440.0f, kRate, out);
  const double at440 = *out;
  core_goertzel_power(buffer, 1000.0f, kRate, out);
  const double at1000 = *out;
  std::printf("        440 Hz = %.2f, 1000 Hz = %.2f\n", at440, at1000);
  expect(rc == 0, "core_goertzel_power returned CORE_OK at the tone's own frequency");
  expect(at440 > 0.0, "power at 440 Hz is positive");
  expect(at440 > at1000 * 100.0, "440 Hz beats 1000 Hz by more than 100x");

  expect(core_goertzel_power(nullptr, 440.0f, kRate, out) < 0, "a null buffer is refused");
  expect(core_goertzel_power(buffer, 0.0f, kRate, out) < 0, "a zero frequency is refused");
  expect(core_goertzel_power(buffer, kRate * 2.0f, kRate, out) < 0, "a frequency above the sample rate is refused");

  expect(core_buffer_free(buffer) == 0, "core_buffer_free accepted the pointer it handed out");
  expect(core_scratch_free(scratch) == 0, "core_scratch_free accepted the pointer it handed out");

  // The streaming embedder, the way a plugin drives it: frame the payload through the core, make a stream
  // off the audio thread, push host-sized blocks through it, and read the result back with the core's own
  // reader. Nothing here knows how a mark is made or found.
  std::printf("  streaming embedder, as a plugin would drive it\n");
  const char* text = "urn:x:link-check";
  uint8_t frame[256];
  const int32_t frame_len = core_frame_encode(reinterpret_cast<const uint8_t*>(text), std::strlen(text), 0, frame, sizeof frame);
  expect(frame_len == static_cast<int32_t>(core_frame_bytes_for(std::strlen(text))), "core_frame_encode wrote the frame the core says it should");
  expect(core_frame_encode(reinterpret_cast<const uint8_t*>(text), std::strlen(text), 0, frame, 4) < 0, "a frame that does not fit is refused");
  expect(core_mark_create(frame, 3, 1, 0, 44100.0, -6.0, 2, 0) == nullptr, "a frame shorter than a header is refused");
  expect(core_mark_create(frame, frame_len, 1, 0, 100.0, -6.0, 2, 0) == nullptr, "an absurd sample rate is refused");
  expect(core_mark_create(frame, frame_len, 1, 0, 44100.0, -6.0, 0, 0) == nullptr, "zero channels is refused");

  void* mark = core_mark_create(frame, frame_len, 2, 0, 44100.0, -6.0, 2, 0);
  expect(mark != nullptr, "core_mark_create made a stream");
  const uint32_t latency = core_mark_latency();
  expect(latency == 3072, "the reported latency is the one in docs/vst.md's arithmetic");

  const uint32_t seconds = 40;
  const uint32_t total = seconds * 44100;
  std::vector<float> left(total), right(total), out_left(total), out_right(total);
  unsigned state = 12345;
  for (uint32_t i = 0; i < total; i++) {
    state = state * 1664525u + 1013904223u;
    const float noise = (static_cast<float>(state >> 8) / 16777216.0f - 0.5f) * 0.04f;
    const float t = static_cast<float>(i) / 44100.0f;
    const float envelope = 0.5f + 0.5f * std::sin(2.0f * 3.14159265f * 0.5f * t);
    left[i] = envelope * (0.25f * std::sin(2.0f * 3.14159265f * 220.0f * t) + 0.1f * std::sin(2.0f * 3.14159265f * 880.0f * t)) + noise;
    right[i] = envelope * (0.25f * std::sin(2.0f * 3.14159265f * 247.0f * t) + 0.1f * std::sin(2.0f * 3.14159265f * 990.0f * t)) - noise;
  }
  // A host hands over blocks of whatever size it likes, and changes it between calls.
  const uint32_t sizes[] = {64, 480, 1024, 333, 4096, 17, 2048};
  uint32_t at = 0;
  uint32_t which = 0;
  bool all_ok = true;
  while (at < total) {
    const uint32_t n = std::min(sizes[which++ % 7], total - at);
    const float* in[2] = {left.data() + at, right.data() + at};
    float* outp[2] = {out_left.data() + at, out_right.data() + at};
    all_ok = all_ok && core_mark_process(mark, in, outp, n) == 0;
    at += n;
  }
  expect(all_ok, "core_mark_process accepted every block");
  expect(core_mark_process(nullptr, nullptr, nullptr, 1) < 0, "a null handle is refused");
  expect(core_mark_set_margin(mark, -9.0) == 0, "the margin can be moved");

  // Output is delayed by the latency, so take the audio from there, and read it with the core's own reader.
  const uint32_t usable = total - latency;
  float* planar = core_buffer_new(usable * 2);
  float* planar_data = core_buffer_data(planar);
  std::memcpy(planar_data, out_left.data() + latency, usable * sizeof(float));
  std::memcpy(planar_data + usable, out_right.data() + latency, usable * sizeof(float));
  core_buffer_set_len(planar, usable * 2);
  float* sink = core_buffer_new(70000);
  double confidence = 0.0, speed = 0.0;
  const int32_t found = core_ss_detect(planar, 44100.0, 2, 0, 2, sink, &confidence, &speed);
  expect(found == 0, "the core's reader verifies the mark the stream wrote");
  if (found == 0) {
    const float* read_back = core_buffer_data(sink);
    const uint8_t* bytes = reinterpret_cast<const uint8_t*>(read_back);
    expect(std::memcmp(bytes, frame, frame_len) == 0, "and it is the frame that went in");
  }
  std::printf("        confidence %.1f, speed %.6f\n", confidence, speed);
  core_buffer_free(planar);
  core_buffer_free(sink);

  expect(core_mark_destroy(mark) == 0, "core_mark_destroy freed the stream");
  expect(core_mark_destroy(nullptr) == 0, "destroying null is accepted");

  if (failures > 0) {
    std::printf("native link check: %d failure(s)\n", failures);
    return 1;
  }
  std::printf("native link check: passed\n");
  return 0;
}