#!/usr/bin/env bash
# install.sh
#
# Build the FluidMark plugin (VST3) and copy it to ~/.vst3.
#
#   ./install.sh                 build, test the engine and the wrapper, install
#   ./install.sh --no-test       skip the tests
#   ./install.sh --uninstall     remove the installed plugin
#   VST3_DIR=/some/where ./install.sh     install somewhere else
#   FLUIDMARK_DPF_DIR=/path/to/DPF ./install.sh   use a DPF checkout other than downspout's
#
# What it needs: cmake, a C++20 compiler, cargo (Rust), and what DPF's UI needs on Linux (X11, OpenGL and dbus
# development packages). DPF itself is taken from ~/github/downspout/third_party/DPF by default, so it is not
# vendored twice. Linux only for now: macOS and Windows are untested (docs/vst.md).
#
# Installing copies one directory into the VST3 folder and nothing else. The old copy is replaced, so a rescan in the
# DAW is all that is left to do.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="$root/build/vst"
bundle_name="fluidmark_mark.vst3"
dest_dir="${VST3_DIR:-$HOME/.vst3}"
run_tests=1
uninstall=0

for arg in "$@"; do
  case "$arg" in
    --no-test) run_tests=0 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [[ $uninstall -eq 1 ]]; then
  if [[ -d "$dest_dir/$bundle_name" ]]; then
    rm -rf "$dest_dir/$bundle_name"
    echo "removed $dest_dir/$bundle_name"
  else
    echo "nothing to remove at $dest_dir/$bundle_name"
  fi
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "this installer is Linux only so far; macOS and Windows are untested (docs/vst.md)" >&2
  exit 1
fi

missing=()
for tool in cmake cargo g++; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  echo "missing: ${missing[*]}" >&2
  echo "install them first (for example: sudo apt install cmake g++ and rustup for cargo)" >&2
  exit 1
fi

dpf="${FLUIDMARK_DPF_DIR:-$HOME/github/downspout/third_party/DPF}"
if [[ ! -f "$dpf/CMakeLists.txt" ]]; then
  echo "DPF not found at $dpf" >&2
  echo "set FLUIDMARK_DPF_DIR to a DPF checkout (git clone https://github.com/DISTRHO/DPF)" >&2
  exit 1
fi

echo "==> configuring ($build)"
cmake -S "$root/vst" -B "$build" -DCMAKE_BUILD_TYPE=Release -DFLUIDMARK_DPF_DIR="$dpf"

echo "==> building (the Rust core, the engine, the plugin)"
cmake --build "$build" -j "$(nproc 2>/dev/null || echo 4)"

bundle="$build/bin/$bundle_name"
if [[ ! -d "$bundle" ]]; then
  echo "the build finished but $bundle is not there" >&2
  exit 1
fi

if [[ $run_tests -eq 1 ]]; then
  echo "==> testing the engine and the wrapper"
  ctest --test-dir "$build" --output-on-failure
fi

echo "==> installing to $dest_dir"
mkdir -p "$dest_dir"
rm -rf "$dest_dir/$bundle_name"
cp -r "$bundle" "$dest_dir/$bundle_name"

echo
echo "installed $dest_dir/$bundle_name"
echo "rescan plugins in your DAW, then put FluidMark last in the master chain."
echo "it does nothing until an identifier is typed in the plugin window."
