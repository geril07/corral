#!/usr/bin/env bash
# Runs a command against a private headless sway, so test windows render on the real GPU
# without appearing on (or taking focus from) your desktop.
# Usage: scripts/headless.sh <command...>
# Caveat: the headless output paces frames at 60 Hz, so fps/latency are only comparable
# to other headless runs, not to your 120 Hz display.
set -euo pipefail

runtime=${XDG_RUNTIME_DIR:?}
dir=$(mktemp -d)
trap 'kill "$sway" 2>/dev/null || true; rm -rf "$dir"' EXIT

cat >"$dir/sway.conf" <<'EOF'
output HEADLESS-1 mode --custom 2560x1440@120Hz
default_border none
# Corral's Electron windows manage their own size: tests set exact widths, and tiling would
# resize a window when another worker's window opens or closes in the same workspace.
for_window [app_id="corral-desktop"] floating enable
EOF

before=$(ls "$runtime" | grep -E '^wayland-[0-9]+$' || true)
env -u WAYLAND_DISPLAY -u SWAYSOCK -u DISPLAY WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
  sway -c "$dir/sway.conf" >"$dir/sway.log" 2>&1 &
sway=$!

display=
for _ in $(seq 50); do
  display=$(comm -13 <(echo "$before") <(ls "$runtime" | grep -E '^wayland-[0-9]+$') | head -n1)
  [[ -n $display ]] && break
  sleep 0.1
done
[[ -n $display ]] || { cat "$dir/sway.log" >&2; exit 1; }

env -u DISPLAY WAYLAND_DISPLAY="$display" "$@"
