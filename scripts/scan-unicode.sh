#!/usr/bin/env bash
# Scan model-facing files for invisible Unicode injection (TrapDoor campaign).
# Run before push: bash scripts/scan-unicode.sh
# Exit code 1 = suspicious characters found.

set -euo pipefail

PATTERN='[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{2066}-\x{206F}\x{FEFF}\x{FFF9}-\x{FFFB}\x{00AD}]|[\x{E0000}-\x{E007F}]'

FOUND=0
while IFS= read -r file; do
  HITS=$(tail -c +4 "$file" 2>/dev/null | grep -Pn "$PATTERN" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    echo "ALERT: Invisible Unicode in $file"
    echo "$HITS" | sed "s/^/  $file:/"
    FOUND=1
  fi
done < <(find . -type f \( -name '*.md' -o -name '.cursorrules' -o -name 'AGENTS.md' -o -name 'CLAUDE.md' \) -not -path '*/node_modules/*' -not -path '*/.git/*')

if [ "$FOUND" = "1" ]; then
  echo ""
  echo "BLOCKED — Invisible Unicode injection detected. Review flagged lines above."
  exit 1
fi

echo "Clean — no invisible Unicode injection found."
