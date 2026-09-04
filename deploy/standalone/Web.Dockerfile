# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
RUN pnpm install --frozen-lockfile
COPY index.html ./index.html
COPY public ./public
COPY src ./src
RUN pnpm build:web

FROM nginx:1.29.8-alpine3.23@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS runtime

ARG COMETA_RELEASE_ID
LABEL org.opencontainers.image.title="Cometa Bank web" \
  org.opencontainers.image.version="${COMETA_RELEASE_ID}"
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=4 \
  CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/healthz"]
