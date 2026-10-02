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

  if (failures > 0) {
    std::printf("native link check: %d failure(s)\n", failures);
    return 1;
  }
  std::printf("native link check: passed\n");
  return 0;
}