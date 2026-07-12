#!/usr/bin/env bash
# Backup notturno Report Officina: database (rotazione 14 giorni) + mirror foto
set -euo pipefail
DEST=/var/backups/reportofficina
mkdir -p "$DEST/db" "$DEST/uploads-mirror"
STAMP=$(date +%Y%m%d-%H%M)

# 1. dump del database (formato custom, comprimibile e ripristinabile selettivamente)
sudo -u postgres pg_dump -Fc reportofficina > "$DEST/db/reportofficina-$STAMP.dump"

# 2. mirror delle foto (incrementale)
rsync -a --delete /opt/reportofficina/uploads/ "$DEST/uploads-mirror/"

# 3. rotazione: tieni gli ultimi 14 dump
ls -1t "$DEST/db"/*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f

# 4. avviso nel journal se il disco scende sotto 2GB
FREE_KB=$(df --output=avail / | tail -1)
if [ "$FREE_KB" -lt 2097152 ]; then
  logger -t reportofficina-backup "ATTENZIONE: spazio disco sotto 2GB ($((FREE_KB/1024))MB liberi)"
fi
logger -t reportofficina-backup "backup completato: reportofficina-$STAMP.dump"
