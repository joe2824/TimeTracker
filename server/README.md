# TimeTracker-Server

Ein Container. Er hält die verschlüsselten Datensätze, verwaltet Konten und
liefert die PWA aus.

**Er kann die Daten nicht lesen.** Was bei ihm liegt, ist Chiffrat plus so wenig
Klartext, wie das Abgleichen braucht: Zuordnung zu einem Konto, Art des
Datensatzes, Reihenfolge, Fassung. Nicht darin: welcher Monat, welche Aktivität,
wie lange, welche Notiz.

---

## Vor dem ersten Start: die Domain

Das ist die wichtigste Entscheidung, und sie lässt sich später nicht mehr
korrigieren.

**Passkeys sind fest an `RP_ID` gebunden.** Wird der Dienst später von
`tracker.fritz.box` auf `tracker.example.de` umgezogen, sind **alle**
registrierten Passkeys wertlos, und jeder muss sich über seine
Wiederherstellungs-Phrase neu einrichten.

Also von Anfang an die endgültige Domain eintragen — auch solange der Container
nur im Heimnetz erreichbar ist:

- per Split-DNS die Domain intern auf den Heimserver zeigen lassen
- ein Zertifikat über die DNS-Challenge ausstellen (kein Port 80 nötig)

Nur für die reine Entwicklung ist `localhost` erlaubt; dort akzeptiert WebAuthn
auch HTTP.

---

## Starten

```bash
cp server/.env.example .env      # ausfüllen: ORIGIN, RP_ID, INVITE_CODES
docker compose up -d --build
```

Das Abbild baut beides selbst — die Oberfläche und den Server. Es braucht keinen
vorbereitenden Schritt; ein Abbild, das nur den halben Dienst enthält und den
Rest von aussen erwartet, geht irgendwann unbemerkt kaputt.

Für die Entwicklung ohne Docker legt `npm run pwa:bundle` die gebaute Oberfläche
in `server/static`, sodass `npm run server:dev` sie ausliefert.

Der Container lauscht auf `127.0.0.1:3000`. Davor gehört ein Reverse-Proxy, der
TLS terminiert und weiterreicht — Caddy, Traefik oder nginx, was schon da ist.

Beispiel für Caddy:

```
tracker.example.de {
	reverse_proxy 127.0.0.1:3000
}
```

Der Weckruf-Kanal (`/api/sync/stream`) ist ein langlebiger Server-Sent-Events-
Strom. Bei nginx muss dafür `proxy_buffering off;` gesetzt sein — sonst hält
nginx jedes Ereignis zurück, bis sein Puffer voll ist, und der Kanal ist
unbrauchbar. Caddy und Traefik machen das von selbst richtig.

---

## Einstellungen

| Variable | Bedeutung |
|---|---|
| `ORIGIN` | Vollständige Adresse, z. B. `https://tracker.example.de`. WebAuthn prüft sie exakt. |
| `RP_ID` | Hostname ohne Schema und Port. **Nicht mehr änderbar** — siehe oben. |
| `RP_NAME` | Was der Anmeldedialog des Betriebssystems anzeigt. |
| `INVITE_CODES` | Türklinke für den ersten Menschen. Mehrfach benutzbar, ohne Frist, ohne Spur. Sobald es einen Verwalter gibt, gehört sie geleert. |
| `REGISTRATION_OPEN` | `true` öffnet den Dienst für jeden, der die Adresse kennt. Voreinstellung `false`. |
| `ALLOWED_ORIGINS` | Herkünfte für schreibende Anfragen. Leer = nur `ORIGIN`. |
| `DATA_DIR` | Wohin die Datenbank kommt. Im Container `/data`. |

**Eine leere `INVITE_CODES`-Zeile öffnet den Dienst NICHT.** Das war einmal so
und war ein Konstruktionsfehler: ausgerechnet der sorgfältigere Schritt — die
Türklinke entfernen und Einladungen einzeln vergeben — hätte die Tür
aufgemacht. Geöffnet wird nur über `REGISTRATION_OPEN=true`, und das bringt
Betreiberpflichten mit sich: Impressum, Datenschutzerklärung, Löschkonzept.

---

## Verwalter und Einladungen

Ein Verwalter darf **Einladungen vergeben — sonst nichts.** Insbesondere kann er
keine fremden Daten lesen; das kann der Server selbst nicht. Die Rolle regelt,
wer hereindarf, nicht wer etwas sieht.

Den ersten Verwalter gibt es nur im Container. Das ist die Henne-und-Ei-Frage
jeder Rechteverwaltung, und sie wird dort beantwortet, wo ohnehin nur hinkommt,
wer den Server betreibt:

```bash
# 1. Container starten, im Browser mit einem Code aus INVITE_CODES registrieren
# 2. Nachsehen, wer da ist:
docker compose exec timetracker node admin.mjs liste

# 3. Ernennen — über den Anzeigenamen oder die Kennung:
docker compose exec timetracker node admin.mjs ernenne "Anna"

# 4. INVITE_CODES in der .env leeren und neu starten
```

Danach vergibt der Verwalter Einladungen in den Einstellungen unter „Konto".
Jeder ausgestellte Code gilt **genau einmal**, hat einen Aussteller, auf Wunsch
eine Frist und eine Notiz, wofür er gedacht war — und lässt sich zurückziehen,
solange ihn niemand benutzt hat.

Weitere Befehle:

```bash
docker compose exec timetracker node admin.mjs entziehe "Anna"
docker compose exec timetracker node admin.mjs einladung "für den Kollegen" --tage 14
```

Der letzte ist der Notausgang: Einladungen lassen sich auch ohne Oberfläche
ausstellen, falls gerade kein Verwalter erreichbar ist.

---

## Sichern

Der gesamte Zustand ist eine SQLite-Datei im Volume. Im laufenden Betrieb:

```bash
docker compose exec timetracker \
	node -e "require('better-sqlite3')('/data/timetracker.db').backup('/data/sicherung.db')"
```

Das ist konsistent, auch während geschrieben wird. Ein blosses `cp` der Datei
kann eine halbe Transaktion erwischen.

Zurückspielen: Container stoppen, `sicherung.db` nach `timetracker.db`
umbenennen, starten. Die `-wal`- und `-shm`-Dateien daneben können weg.

---

## Warum SQLite und kein Postgres

Der einzige heisse Pfad ist ein Bereichsscan über `(user_id, seq)` — keine
Verknüpfungen, keine Aggregate. Der Server *kann* nichts rechnen, er sieht nur
Chiffrate. Für dieses Muster ist SQLite im selben Prozess schneller als alles,
was über einen Socket geht, und es kostet keinen zweiten Container.

Gewechselt wird, wenn eines davon eintritt:

1. `SQLITE_BUSY` taucht messbar in den Logs auf,
2. der Dienst braucht **mehr als eine Instanz**,
3. Replikation oder Point-in-Time-Recovery wird zur Anforderung.

Punkt 2 zieht Redis mit: sobald zwei Instanzen laufen, muss ein Weckruf von
Instanz A einen Client an Instanz B erreichen. Beides gehört in dieselbe
Ausbaustufe, nicht in die erste. Vorbereitet ist es: das Weiterreichen der
Ereignisse liegt hinter `publish`/`subscribe` in `src/lib/server/events.ts`, und
alle Endpunkte sind zustandslos.

---

## Ressourcen

Zielgrössen, an denen der Entwurf gemessen wird:

| Grösse | Ziel |
|---|---|
| Arbeitsspeicher im Ruhezustand | < 120 MB |
| CPU im Leerlauf | praktisch 0 |
| Datenverkehr je Arbeitstag und Gerät | wenige KB |
| Container im Stack | **einer** |

Der laufende Timer erzeugt **keinen** laufenden Datenverkehr: er ist ein
Datensatz mit einem Startzeitpunkt, die Dauer rechnet jedes Gerät selbst. Start
und Stopp sind je *eine* Anfrage.

---

## Entkoppeln und Löschen

Drei Stufen, weil das Wort drei Dinge heißen kann. In **jeder** bleiben die
erfassten Zeiten auf dem Gerät vollständig erhalten — der Server war nie ihre
einzige Kopie.

| Stufe | Was passiert | Wer darf |
|---|---|---|
| Nur hier vergessen | Das Gerät gleicht nicht mehr ab. Der Zugang bleibt gültig. | Niemand muss gefragt werden — es passiert nur lokal. |
| Gerät trennen | Der Zugang dieses Geräts erlischt auch beim Server. Konto und andere Geräte bleiben. | Das Gerät selbst, über sein Token. |
| Konto auflösen | Alles beim Server wird gelöscht: Chiffrate, Passkeys, verpackte Schlüssel, alle Geräte. | Über eine Browser-Sitzung nur mit frischer Passkey-Bestätigung samt Nutzerprüfung. Über ein Geräte-Token unmittelbar. |

**Warum die Sitzung nicht genügt:** ein Cookie fährt bei jeder Anfrage
automatisch mit. Es beweist, dass irgendwann jemand angemeldet war, nicht dass
gerade jetzt jemand zustimmt. Ein Geräte-Token dagegen sind 256 Bit, die genau
einmal bei der Kopplung über die Leitung gingen und in keinem Browser-Kontext
liegen — wer es hat, hat das gekoppelte Gerät und damit ohnehin den
Tresorschlüssel.

**Was physisch verschwindet.** SQLite markiert gelöschte Seiten normalerweise
nur als frei; der Inhalt bleibt in der Datei stehen, bis die Seite zufällig
wiederverwendet wird. Deshalb läuft die Datenbank mit `secure_delete`, und nach
dem Auflösen eines Kontos wird das Schreibprotokoll abgeschnitten. Nachgemessen:
ein Chiffrat, das vorher einmal in der Datei zu finden war, ist danach nirgends
mehr auffindbar.

Was **nicht** mitgelöscht wird: der verbrauchte Einladungscode bleibt verbraucht
— sonst ließen sich durch Löschen und Neuanlegen beliebig viele Konten damit
verschaffen. Nur der Verweis auf den Menschen fällt weg.

---

## Was der Betreiber sehen kann

Ehrlich aufgezählt, weil "verschlüsselt" allein nichts sagt:

**Lesbar:** wie viele Konten es gibt, wann sie angelegt wurden, wie viele
Datensätze jedes hat, wann zuletzt geschrieben wurde, von welchem Gerät, und
eine hinterlegte E-Mail-Adresse (freiwillig).

**Nicht lesbar:** jeder Inhalt. Aktivitätsnamen, Notizen, Zeitstempel der
Einträge, Arbeitszeiten, Einstellungen. Auch nicht, in welchen Monaten
gearbeitet wurde — die Zeitraum-Kennung ist ein HMAC mit dem Schlüssel des
Kontos.

**Der Betreiber kann sich keinen Zugang verschaffen.** Es gibt keine
Schlüsselhinterlegung. Wer alle Geräte und seine Wiederherstellungs-Phrase
verliert, verliert die Daten — auch der Betreiber kann sie dann nicht
zurückholen.
