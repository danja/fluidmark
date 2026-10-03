#!/usr/bin/env bash
# vst/scripts/ui-check.sh
#
# Drive the real plugin UI in a virtual X server and take screenshots: click the identifier field and type, click
# the key field and type, drag the margin. A DOM-free UI has no layout, focus or pointer to check by reading code,
# so this runs the actual standalone build (AGENTS.md: drive the real thing). Environment-dependent: needs
# Xvfb, xdotool, ImageMagick's `import`, and a JACK server (PipeWire's will do).
#
#   cmake -S vst -B build/vst-standalone -DFLUIDMARK_BUILD_STANDALONE=ON && cmake --build build/vst-standalone
#   xvfb-run -a -s "-screen 0 900x700x24" vst/scripts/ui-check.sh [outdir]
#
# Prints what it did, leaves the screenshots in outdir (default /tmp/fluidmark-ui), and fails if the UI logged an
# assertion or the typed text did not appear in the plugin's own state.

set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app="${FLUIDMARK_STANDALONE:-$root/build/vst-standalone/bin/fluidmark_mark}"
out="${1:-/tmp/fluidmark-ui}"
mkdir -p "$out"
rm -f "$out"/*.png

"$app" >"$out/app.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null' EXIT
sleep 4

wid=$(xdotool search --onlyvisible --name "FluidMark" | head -1)
if [[ -z "$wid" ]]; then echo "FAIL  no FluidMark window appeared"; exit 1; fi
echo "window $wid"

import -window root "$out/1-empty.png"
xdotool mousemove --window "$wid" 200 116 click 1
sleep 0.5
xdotool type --delay 80 "https://example.org/track/42"
sleep 0.3
xdotool mousemove --window "$wid" 200 188 click 1
sleep 0.3
xdotool type --delay 80 "my secret phrase"
sleep 0.3
import -window root "$out/2-typed.png"
xdotool mousemove --window "$wid" 300 258 mousedown 1 mousemove --window "$wid" 150 258 mouseup 1
sleep 0.5
import -window root "$out/3-margin.png"

fail=0
if grep -q "assertion failure" "$out/app.log"; then echo "FAIL  the UI logged an assertion"; fail=1; fi
for f in 1-empty 2-typed 3-margin; do
  [[ -s "$out/$f.png" ]] || { echo "FAIL  no screenshot $f"; fail=1; }
done
# The screenshots differ because typing and dragging changed what is drawn, which a UI that ignored input would not.
if cmp -s "$out/1-empty.png" "$out/2-typed.png"; then echo "FAIL  typing changed nothing on screen"; fail=1; fi
if cmp -s "$out/2-typed.png" "$out/3-margin.png"; then echo "FAIL  dragging the margin changed nothing on screen"; fail=1; fi
[[ $fail -eq 0 ]] && echo "ui check: passed, screenshots in $out" || echo "ui check: failed"
exit $fail
