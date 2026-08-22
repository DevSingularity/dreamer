FROM node:22-alpine AS base
WORKDIR /home/app

FROM base AS deps
COPY package*.json ./
RUN npm ci
# COPY prisma ./prisma
# RUN npx prisma generate
# RUN npx prisma migrate deploy

FROM base AS runner
COPY --from=deps /home/app/node_modules ./node_modules
# COPY --from=deps /home/app/prisma ./prisma
COPY . .
RUN apk add --no-cache docker-cli
RUN npx prisma generate

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
