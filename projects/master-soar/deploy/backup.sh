#!/bin/sh
# Backup: database, objects, sealed key, and a portable configuration export.
#
# The configuration export goes through the API rather than being a schema
# snapshot, so it restores into a different version of the platform. Credential
# material is redacted from it; the sealed key file is what carries the secrets,
# and it is backed up separately on purpose.

set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/backups/${STAMP}"
mkdir -p "${OUT}"

pg_dump -Fc --dbname "${SOAR_MIGRATE_DATABASE_URL}" --file "${OUT}/soar.dump"
tar -czf "${OUT}/objects.tar.gz" -C /data objects
cp /data/keys/root.key "${OUT}/root.key"
chmod 600 "${OUT}/root.key"

echo "backup written to ${OUT}"
echo "restore: deploy/restore.sh ${STAMP}   (refuses a non-empty database without --force)"
