#!/bin/sh
set -e
echo "Running migrations..."
npx prisma migrate deploy
echo "Migrations complete. Starting application..."
exec "$@"
