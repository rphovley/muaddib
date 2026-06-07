#!/usr/bin/env bash
# Build MuaddibApp and wrap it in a minimal .app bundle.
# LSUIElement in the Info.plist suppresses the Dock icon.
#
# Usage (from repo root or muaddib/MuaddibApp/):
#   ./muaddib/MuaddibApp/build.sh
#
# Then launch: open muaddib/MuaddibApp/MuaddibApp.app
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "→ building (release)…"
swift build -c release

BINARY="$DIR/.build/release/MuaddibApp"
APP="$DIR/MuaddibApp.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BINARY" "$APP/Contents/MacOS/MuaddibApp"
cp "$DIR/Resources/MuaddibApp-Info.plist" "$APP/Contents/Info.plist"

echo "✓ built: $APP"
echo "  run:   open \"$APP\""
