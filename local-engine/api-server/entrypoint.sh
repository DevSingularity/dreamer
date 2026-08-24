#!/bin/sh
set -e
echo "Running migrations..."
npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
echo "Migrations complete. Starting application..."
exec "$@"
