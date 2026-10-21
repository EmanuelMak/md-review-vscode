#!/usr/bin/env bash
# Markdown Review auf einem Rechner installieren (macOS/Linux): neuestes Release laden und in VS Code installieren.
# Danach aktualisiert sich die Extension selbst.
set -euo pipefail
REPO="${MD_REVIEW_REPO:-EmanuelMak/md-review-vscode}"
CODE="${CODE_BIN:-code}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.vsix"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$url" ] || { echo "Kein Release mit .vsix in $REPO gefunden." >&2; exit 1; }
echo "Lade $url"
curl -fsSL -o "$tmp/md-review.vsix" "$url"
"$CODE" --install-extension "$tmp/md-review.vsix" --force
echo "Fertig. In offenen VS Code-Fenstern: Erweiterungen → „Restart Extensions“ (oder Developer: Reload Window)."
