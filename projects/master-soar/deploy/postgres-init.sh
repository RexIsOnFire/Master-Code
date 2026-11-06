#!/bin/sh
# Create the least-privilege roles at first boot.
#
# This wrapper exists because Postgres runs *.sql files in initdb.d through psql
# with no variable bindings, so a script containing :'app_password' reaches the
# server with the colon still in it and initialisation fails. Binding them with
# -v also means psql does the quoting, so a password containing a quote is not
# an injection.
set -eu

if [ -z "${SOAR_APP_PG_PASSWORD:-}" ] || [ -z "${SOAR_WORKER_PG_PASSWORD:-}" ]; then
  echo "SOAR_APP_PG_PASSWORD and SOAR_WORKER_PG_PASSWORD must be set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
     -v app_password="$SOAR_APP_PG_PASSWORD" \
     -v worker_password="$SOAR_WORKER_PG_PASSWORD" \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     --file /opt/soar/roles.sql

# TLS, with a self-signed certificate generated here on first boot.
#
# The stock image ships ssl = off, and every DSN in this deployment says
# sslmode=require - the driver refuses a DSN that does not. Without this the
# platform cannot reach its own database.
#
# sslmode=require encrypts without verifying the issuer, which is the right
# setting for a certificate that exists only inside this compose project. A
# deployment with a real CA uses verify-full and mounts its own pair over these.
#
# ALTER SYSTEM writes postgresql.auto.conf, and the entrypoint restarts the
# server once initialisation finishes - so this takes effect on the real start,
# not on the temporary one this script is talking to.
openssl req -new -x509 -days 3650 -nodes -text \
        -out "$PGDATA/server.crt" \
        -keyout "$PGDATA/server.key" \
        -subj "/CN=master-soar-postgres" >/dev/null 2>&1

chmod 600 "$PGDATA/server.key"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -c "ALTER SYSTEM SET ssl = on;"
