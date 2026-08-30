# syntax=docker/dockerfile:1
# Ein Abbild, ein Prozess, ein Volume.
#
# Mehrstufig optimiert:
# 1. js-builder: Baut die Web-Oberflaeche (PWA) und den Server-JS-Code auf der nativen
#    Host-Architektur ($BUILDPLATFORM) in wenigen Sekunden, anstatt ihn in langsamer
#    QEMU-Emulation auszufuehren.
# 2. build: Installiert ausschliesslich die Server-Produktionsabhaengigkeiten auf der
#    Zielarchitektur ($TARGETPLATFORM) und kompiliert better-sqlite3.
# 3. runtime: Minimales Alpine-Produktionsabbild.

# ---------- 1. Plattformunabhaengiger JS/PWA Bau (Host-Geschwindigkeit) ----------
FROM --platform=$BUILDPLATFORM node:22-alpine AS js-builder

WORKDIR /app

# Abhaengigkeiten mit BuildKit-Cache installieren
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# Quelltext kopieren und Frontend (PWA) bauen
COPY svelte.config.js vite.config.js tsconfig.json tt ./
COPY scripts ./scripts
COPY src ./src
COPY static ./static
RUN BUILD_TARGET=web npx vite build

# Server-JS bauen und statische PWA-Dateien einbetten
COPY server ./server
RUN cp -r build-web/. server/static/ && npm --workspace server run build

# ---------- 2. Native Abhaengigkeiten (Zielarchitektur) ----------
FROM node:22-alpine AS build

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/

# Nur die schlanken Server-Produktions-Abhaengigkeiten installieren und better-sqlite3 uebersetzen
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace server --include-workspace-root=false --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

# ---------- 3. Betreiben ----------
FROM node:22-alpine AS runtime

RUN apk add --no-cache bash

# Nicht als root. Der Datenordner gehoert dem Dienstkonto, damit die Datenbank
# beschreibbar ist, ohne dass irgendetwas mit vollen Rechten laeuft.
RUN addgroup -S tt && adduser -S tt -G tt

WORKDIR /app
COPY --from=js-builder --chown=tt:tt /app/server/build ./build
COPY --from=js-builder --chown=tt:tt /app/server/static ./static
COPY --from=build --chown=tt:tt /app/node_modules ./node_modules
COPY --from=build --chown=tt:tt /app/server/package.json ./package.json
COPY --from=js-builder --chown=tt:tt /app/server/admin.mjs ./admin.mjs
COPY --from=js-builder --chmod=755 /app/tt /usr/local/bin/tt

RUN mkdir -p /data && chown tt:tt /data
VOLUME ["/data"]

USER tt

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    CLIENT_DIR=/app/static \
    BODY_SIZE_LIMIT=2M

EXPOSE 3000

# Beruehrt die Datenbank, damit ein kaputter Bestand nicht als "gesund" durchgeht.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
