#!/usr/bin/env bash
# Sauvegarde complète de la base (documents compris : ils sont stockés en base).
# Usage : scripts/backup.sh [dossier]          (avec docker compose)
#         DATABASE_URL=postgres://… scripts/backup.sh [dossier]   (base managée)
set -euo pipefail
out="${1:-backups}"
mkdir -p "$out"
file="$out/jobagent-$(date +%Y%m%d-%H%M%S).dump"
if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump --format=custom --no-owner --file "$file" "$DATABASE_URL"
else
  docker compose exec -T db pg_dump --format=custom --no-owner -U jobagent jobagent > "$file"
fi
chmod 600 "$file"
echo "Sauvegarde écrite : $file ($(du -h "$file" | cut -f1))"
echo "Conservez aussi APP_SECRET : sans lui, les secrets chiffrés (clés d'API, jetons) sont illisibles."
