# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.bot.json ./
RUN pnpm install --frozen-lockfile
COPY bot ./bot
RUN pnpm exec tsc -p tsconfig.bot.json --pretty false

FROM node:22.23.2-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /data /run/secrets && chown -R node:node /data /run/secrets
COPY --from=build --chown=node:node /app/bot/dist ./bot
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "bot/main.js"]
