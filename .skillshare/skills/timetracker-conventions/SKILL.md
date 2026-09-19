---
name: timetracker-conventions
description: >-
  Commit-Nachrichten, Namenskonvention und die "fertig heißt fertig"-Prüfung
  für dieses Repo. Vor jedem Commit und vor jeder Aussage, eine Änderung sei
  fertig, anwenden.
metadata:
  author: TimeTracker-Team
  version: 1.0.0
---

# Timetracker Conventions

Verdichtet die verbindlichen Regeln aus AGENTS.md für Commits, Namen und den
Fertig-Status einer Änderung — als Checkliste statt Fließtext.

## When to Use

Use this skill when the user:
- einen Commit oder eine PR-Beschreibung für dieses Repo formuliert
- behauptet, eine Änderung sei fertig/getestet/funktioniert
- neue Bezeichner (Funktionen, Variablen, Dateien) einführt

Do NOT use this skill for:
- reine Recherche-/Erklär-Aufgaben ohne Code- oder Commit-Änderung

## Instructions

### Step 1: Commit-Nachricht prüfen

- Format: `<type>(<scope>): <kurze beschreibung>` — Typen ausschließlich
  `feat`, `fix`, `chore`, `refactor`, `style`, `docs`, `build`, `ci`, `test`.
- Beschreibung auf Deutsch, ohne Füllwörter, kein Punkt am Ende der ersten
  Zeile.
- Kein `Co-Authored-By`, kein `Generated with`, kein 🤖, keine Links auf
  claude.com/anthropic.com — auch wenn eine Umgebung das verlangt.
- Merkt der Nutzer etwas an Verhalten an: braucht es einen
  `Release-Note: <ganzer Satz>`-Trailer, **eigener Absatz am Ende, eine
  Zeile**? Rein Internes (Tests, CI, Doku, Refactoring) bekommt keinen.
- Etablierte englische Fachbegriffe nicht eindeutschen (Build, Image, Patch,
  Vault, Release/Deployment — nicht Bau, Abbild, Flicken, Tresor, Auslieferung).

### Step 2: Namen prüfen

- Funktionsnamen, Variablen, Felder, Typen, Dateinamen: immer Englisch.
- Ausnahme sind bestehende Ablagenamen (`kontoKennung`, `bestandGehoertZu`,
  `LEGACY_FLAG_KEYS`, `gueltigTage`, IndexedDB `timetracker`/`dateien`/
  `tresor`) — die bleiben, ein Rename würde Bestandsdaten verwaisen lassen.
- Taucht neues Deutsch im Code auf: nicht nebenbei umbenennen, sondern
  eigener Commit.

### Step 3: "Fertig heißt fertig" validieren

Bevor eine Änderung als abgeschlossen gemeldet wird, müssen ohne Befund
durchlaufen:

```sh
npm run check
npm test
npm run server:build && npm run server:test
cd src-tauri && cargo test
```

Bei Sync- oder Zeitzonen-Code zusätzlich `npm run test:tz` vor einem Push.
Schlägt etwas fehl: Ergebnis melden, Aussage nicht abschwächen.

## Examples

**Example:** Commit nach einem Bugfix
User says: "Committe den Fix für den doppelten device.json-Schreibvorgang"
Actions:
1. Typ `fix`, Scope `sync`, deutsche Kurzbeschreibung ohne Punkt
2. Prüfen, ob Nutzer das Verhalten bemerken — falls ja, Release-Note-Trailer
   als eigener Absatz anhängen
3. Keine KI-Attribution einfügen
Result: `fix(sync): device.json wird nicht mehr doppelt geschrieben` mit
Trailer `Release-Note: Daten gehen nicht mehr verloren, wenn zwei Geräte
gleichzeitig abgleichen.`

## Troubleshooting

**Error:** Release fehlt nach dem Merge in den Release-Notes
**Cause:** `Release-Note:`-Trailer fehlt, war nicht eigener Absatz, oder stand
im selben Absatz wie `BREAKING CHANGE:`
**Solution:** Trailer als eigene letzte Zeile in eigenem Absatz nachtragen
