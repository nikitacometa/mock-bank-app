# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.bot.json ./
RUN pnpm install --frozen-lockfile
COPY bot ./bot
RUN pnpm exec tsc -p tsconfig.bot.json --pretty false

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ARG COMETA_RELEASE_ID
LABEL org.opencontainers.image.title="Cometa Bank Telegram bot" \
  org.opencontainers.image.version="${COMETA_RELEASE_ID}"
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 cometa \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin cometa \
  && install -d -m 0700 -o 10001 -g 10001 /data /run/secrets
COPY --from=build --chown=10001:10001 /app/bot/dist ./bot
COPY --from=build --chown=10001:10001 /app/package.json ./package.json

USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "bot/main.js"]
