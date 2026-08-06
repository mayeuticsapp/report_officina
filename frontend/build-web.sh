#!/usr/bin/env bash
# Build web di Report Officina: expo export + iniezione tag PWA nell'index.html
# (con web.output "single" Expo ignora app/+html.tsx, quindi li aggiungiamo qui).
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
EXPO_PUBLIC_BACKEND_URL="" ./node_modules/.bin/expo export --platform web

python3 - <<'EOF'
import os
path = "dist/index.html"
s = open(path).read()
s = s.replace("<title>frontend</title>", "<title>Report Officina</title>")
tags = (
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />'
    '<link rel="manifest" href="/manifest.json" />'
    '<meta name="theme-color" content="#09090B" />'
    '<link rel="apple-touch-icon" href="/icon-192.png" />'
    '<meta name="mobile-web-app-capable" content="yes" />'
)
assert "manifest.json" not in s
s = s.replace("</title>", "</title>" + tags, 1)
open(path, "w").write(s)
print("PWA tags iniettati in", path)

# Rimuovi favicon.ico vecchio (E di Emergent)
favicon_ico = "dist/favicon.ico"
if os.path.exists(favicon_ico):
    os.remove(favicon_ico)
    print("Rimosso favicon.ico (E di Emergent)")
EOF

echo "Build completata: dist/"
