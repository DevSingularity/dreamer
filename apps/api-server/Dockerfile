FROM node:22-alpine AS base
WORKDIR /home/app

FROM base AS deps
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

FROM base AS runner
COPY --from=deps /home/app/node_modules ./node_modules
COPY --from=deps /home/app/prisma ./prisma
COPY . .
RUN npx prisma generate

EXPOSE 8000
CMD ["npx", "tsx", "src/index.ts"]
