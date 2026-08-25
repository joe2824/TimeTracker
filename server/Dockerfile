# Ein Abbild, ein Prozess, ein Volume.
#
# Mehrstufig, damit die Bauwerkzeuge nicht im Ergebnis landen: das fertige Abbild
# enthaelt Node, den gebauten Server und die Abhaengigkeiten fuer den Betrieb -
# sonst nichts.

# ---------- Bauen ----------
FROM node:22-alpine AS build

# better-sqlite3 ist eine native Erweiterung. Auf Alpine gibt es kein fertiges
# Paket, sie wird also uebersetzt - dafuer braucht es kurzzeitig eine Werkzeugkette.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Erst die Manifeste, dann der Rest: solange sich die Abhaengigkeiten nicht
# aendern, bleibt diese Schicht im Zwischenspeicher und der Bau dauert Sekunden
# statt Minuten.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --workspace server --include-workspace-root=false

COPY server ./server
# Die gebaute PWA gehoert mit ins Abbild: der Server liefert sie aus. Sie wird
# VOR dem Docker-Bau erzeugt ("npm run pwa:bundle") und liegt dann in
# server/static - deshalb kommt sie mit dem COPY oben schon mit.
RUN npm --workspace server run build

# Die Abhaengigkeiten fuer den Betrieb noch einmal frisch, ohne die des Baus.
RUN npm ci --workspace server --include-workspace-root=false --omit=dev

# ---------- Betreiben ----------
FROM node:22-alpine AS runtime

# Nicht als root. Der Datenordner gehoert dem Dienstkonto, damit die Datenbank
# beschreibbar ist, ohne dass irgendetwas mit vollen Rechten laeuft.
RUN addgroup -S tt && adduser -S tt -G tt

WORKDIR /app
COPY --from=build --chown=tt:tt /app/server/build ./build
COPY --from=build --chown=tt:tt /app/node_modules ./node_modules
COPY --from=build --chown=tt:tt /app/server/package.json ./package.json

RUN mkdir -p /data && chown tt:tt /data
VOLUME ["/data"]

USER tt

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    BODY_SIZE_LIMIT=2M

EXPOSE 3000

# Beruehrt die Datenbank, damit ein kaputter Bestand nicht als "gesund" durchgeht.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build/index.js"]
