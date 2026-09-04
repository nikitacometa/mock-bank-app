#!/usr/bin/env bash
# CSS guards the JS linter cannot see (TMA-port seam, docs/spec.md §5.1):
#  1. raw env(safe-area-inset-*) is allowed only in tokens.css and platform/ —
#     everywhere else use the semantic vars owned by the platform layer;
#  2. raw 100vh/100dvh is banned — use var(--app-height);
#  3. Tailwind scans only src/, so local and container builds see the same sources.
set -u
fail=0

hits=$(grep -rn 'env(safe-area-inset' src --include='*.css' --include='*.tsx' --include='*.ts' \
  | grep -v 'src/styles/tokens.css' | grep -v 'src/platform/' || true)
if [ -n "$hits" ]; then
  echo "raw env(safe-area-inset-*) outside tokens.css/platform:"; echo "$hits"; fail=1
fi

hits=$(grep -rnE '100(d)?vh' src --include='*.css' --include='*.tsx' --include='*.ts' \
  | grep -v 'src/styles/tokens.css' | grep -v 'src/platform/' || true)
if [ -n "$hits" ]; then
  echo "raw 100vh/100dvh outside tokens.css/platform (use var(--app-height)):"; echo "$hits"; fail=1
fi

if ! grep -Fxq "@import 'tailwindcss' source('../');" src/styles/tokens.css; then
  echo "tokens.css must pin Tailwind source detection to src/"; fail=1
fi

if [ "$fail" -eq 0 ]; then echo "css guards: OK"; fi
exit "$fail"
