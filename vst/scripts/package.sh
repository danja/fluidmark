#!/usr/bin/env bash
# vst/scripts/package.sh
#
# Check a built plugin bundle and zip it with a checksum.
#
#   package.sh <platform> <bundle.vst3> <dist-dir> <version>
#   platform: linux-x86_64 | macos-universal | windows-x86_64
#
# A bundle directory alone proves nothing: DPF writes the Contents skeleton at configure time, so a build that died in
# `make` leaves an empty shell that zips perfectly well. Every bundle is therefore checked for the platform binary, and
# for the thing that makes it loadable on a machine that is not the build machine:
#
#   macOS    both architectures are in the binary, and it is ad-hoc signed (Apple Silicon will not load an unsigned one)
#   Windows  the DLL imports none of MinGW's runtime DLLs, which a user's machine does not have
#   Linux    nothing beyond the system libraries a DAW already needs
#
# A failed check exits non-zero, so the job is red. Nothing here is "best effort".

set -euo pipefail

platform="${1:?platform}"
bundle="${2:?bundle}"
dist="${3:?dist dir}"
version="${4:?version}"

fail() { echo "package.sh: $*" >&2; exit 1; }

[[ -d "$bundle" ]] || fail "no bundle at $bundle"
name="$(basename "$bundle" .vst3)"

case "$platform" in
  linux-*)
    binary="$(find "$bundle" -type f -name '*.so' -print -quit)"
    [[ -n "$binary" ]] || fail "no .so in $bundle"
    echo "linux binary: $binary"
    ldd "$binary" | sed 's/^/  /'
    if ldd "$binary" | grep -q "not found"; then fail "the binary has unresolved libraries"; fi
    ;;
  macos-*)
    binary="$(find "$bundle/Contents/MacOS" -maxdepth 1 -type f -print -quit 2>/dev/null || true)"
    [[ -n "$binary" ]] || fail "no binary in $bundle/Contents/MacOS"
    archs="$(lipo -archs "$binary")"
    echo "macOS architectures: $archs"
    for want in x86_64 arm64; do
      [[ " $archs " == *" $want "* ]] || fail "the binary is missing the $want slice (has: $archs)"
    done
    # Ad hoc, because there is no developer certificate here. A downloaded copy will still be quarantined by Gatekeeper
    # and needs `xattr -dr com.apple.quarantine`, which the release notes say.
    codesign --force --deep --sign - "$bundle"
    codesign --verify --deep --strict "$bundle" || fail "the ad-hoc signature does not verify"
    ;;
  windows-*)
    binary="$(find "$bundle" -type f -name '*.vst3' -print -quit)"
    [[ -n "$binary" ]] || fail "no .vst3 DLL in $bundle"
    echo "windows binary: $binary"
    file "$binary" | sed 's/^/  /'
    objdump="${OBJDUMP:-x86_64-w64-mingw32-objdump}"
    command -v "$objdump" >/dev/null 2>&1 || objdump=objdump
    imports="$("$objdump" -p "$binary" | grep -i "DLL Name" | sed 's/^[[:space:]]*//')"
    echo "$imports" | sed 's/^/  /'
    if echo "$imports" | grep -qiE 'libgcc|libstdc\+\+|libwinpthread'; then
      fail "the DLL imports MinGW runtime DLLs, which a user's machine does not have: the static link did not take"
    fi
    ;;
  *) fail "unknown platform $platform" ;;
esac

mkdir -p "$dist"
zip_name="fluidmark-${version}-${platform}-vst3.zip"
parent="$(cd "$(dirname "$bundle")" && pwd)"
# -y keeps symlinks as symlinks, which a macOS bundle can contain.
(cd "$parent" && rm -f "$dist/$zip_name" && zip -q -r -y "$(cd "$dist" && pwd)/$zip_name" "$name.vst3")
(cd "$dist" && if command -v sha256sum >/dev/null; then sha256sum "$zip_name"; else shasum -a 256 "$zip_name"; fi > "$zip_name.sha256")
echo "packaged $dist/$zip_name"
cat "$dist/$zip_name.sha256"
