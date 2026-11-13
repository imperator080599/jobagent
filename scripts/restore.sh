#!/usr/bin/env bash
# Restauration d'une sauvegarde produite par scripts/backup.sh.
# ATTENTION : remplace le contenu de la base cible.
# Usage : scripts/restore.sh backups/jobagent-AAAAMMJJ-HHMMSS.dump
set -euo pipefail
file="${1:?Indiquez le fichier de sauvegarde}"
[ -f "$file" ] || { echo "Fichier introuvable : $file" >&2; exit 1; }
read -r -p "Remplacer le contenu de la base par $file ? (oui/non) " answer
[ "$answer" = "oui" ] || { echo "Annulé."; exit 1; }
if [ -n "${DATABASE_URL:-}" ]; then
  pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$file"
else
  docker compose stop app
  docker compose exec -T db pg_restore --clean --if-exists --no-owner -U jobagent -d jobagent < "$file"
  docker compose start app
fi
echo "Restauration terminée. Vérifiez que APP_SECRET est le même qu'au moment de la sauvegarde."
