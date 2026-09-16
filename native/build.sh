#!/bin/bash
# Build the dsh-cua native module.
#
# Produces dsh_cua.node: the Swift accessibility core plus a C N-API binding.
# The addon uses N-API only, so one binary loads in both standalone Node and
# Electron.
#
# Note: the Swift sources are compiled with -wmo (whole-module optimization).
# Cross-file references to internal symbols do not resolve otherwise, because
# swiftc emits one object per input file when building incrementally.
set -euo pipefail

cd "$(dirname "$0")"

NODE_INCLUDE="${NODE_INCLUDE:-$HOME/.nvm/versions/node/v24.14.0/include/node}"
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "error: node_api.h not found at $NODE_INCLUDE" >&2
  echo "hint: set NODE_INCLUDE to a directory containing node_api.h" >&2
  exit 1
fi

SWIFT_SOURCES="axcore.swift actions.swift input.swift screenshots.swift abi.swift"

echo "==> compiling Swift core (-wmo)"
swiftc -O -wmo -module-name DshCua -c $SWIFT_SOURCES -o cua_core.o

echo "==> compiling N-API binding"
clang -c -O2 -fPIC -I"$NODE_INCLUDE" addon.c -o addon.o

echo "==> linking dsh_cua.node"
clang -shared -undefined dynamic_lookup \
  -o dsh_cua.node addon.o cua_core.o \
  -framework AppKit \
  -framework ApplicationServices \
  -framework Foundation \
  -framework CoreGraphics \
  -framework ScreenCaptureKit \
  -framework ImageIO \
  -framework UniformTypeIdentifiers \
  -framework Carbon

echo "==> built $(pwd)/dsh_cua.node ($(stat -f%z dsh_cua.node) bytes)"
