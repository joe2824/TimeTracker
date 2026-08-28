# Ein Abbild, ein Prozess, ein Volume.
#
# Es baut BEIDES: die Oberflaeche (PWA) und den Server. Ein Abbild, das nur den
# halben Dienst enthaelt und den Rest von aussen erwartet, geht irgendwann
# unbemerkt kaputt - dann laeuft der Server, aber die Anwendung fehlt.
#
# Mehrstufig, damit die Bauwerkzeuge nicht im Ergebnis landen.

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
RUN npm ci

# Die Oberflaeche - dieselbe Quelle wie fuer die Desktop-Anwendung, nur ein
# anderes Ziel.
COPY svelte.config.js vite.config.js tsconfig.json ./
COPY src ./src
COPY static ./static
RUN BUILD_TARGET=web npx vite build

# Der Server. Die gebaute Oberflaeche kommt in seinen static-Ordner, damit er
# sie ausliefert.
COPY server ./server
RUN cp -r build-web/. server/static/ && npm --workspace server run build

# Die Abhaengigkeiten fuer den Betrieb noch einmal frisch, ohne die des Baus.
#
# --ignore-scripts ist noetig, nicht Vorsicht: das Wurzelpaket hat ein
# prepare-Skript, das "svelte-kit sync" ruft - und svelte-kit ist gerade als
# Bauwerkzeug mit --omit=dev entfernt worden. Ohne das Auslassen scheitert der
# Schritt an einem Werkzeug, das im fertigen Abbild ohnehin nichts zu suchen hat.
#
# better-sqlite3 braucht sein Skript aber wirklich: es ist eine native
# Erweiterung und muss uebersetzt werden. Deshalb danach gezielt genau dieses
# eine Paket bauen - der Grund, aus dem die Werkzeugkette oben installiert wurde.
RUN rm -rf node_modules 	&& npm ci --workspace server --include-workspace-root=false --omit=dev --ignore-scripts 	&& npm rebuild better-sqlite3

# ---------- Betreiben ----------
FROM node:22-alpine AS runtime

# Nicht als root. Der Datenordner gehoert dem Dienstkonto, damit die Datenbank
# beschreibbar ist, ohne dass irgendetwas mit vollen Rechten laeuft.
RUN addgroup -S tt && adduser -S tt -G tt

WORKDIR /app
COPY --from=build --chown=tt:tt /app/server/build ./build
COPY --from=build --chown=tt:tt /app/server/static ./static
COPY --from=build --chown=tt:tt /app/node_modules ./node_modules
COPY --from=build --chown=tt:tt /app/server/package.json ./package.json
# Die Verwaltung von der Kommandozeile. Sie gehoert ins Abbild, nicht daneben:
# der erste Verwalter laesst sich nur hier ernennen, und wer den Container hat,
# soll das koennen, ohne erst etwas hineinzukopieren.
COPY --from=build --chown=tt:tt /app/server/admin.mjs ./admin.mjs

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
