---
name: timetracker-ui
description: >-
  Visuelle Konventionen und Anwender-Text-Regeln für die TimeTracker-UI:
  shadcn-svelte-Neutral-Theme, projekteigene Basis-Regeln in app.css,
  Zielgruppen-gerechte Texte. Vor jeder UI-Änderung anwenden.
metadata:
  author: TimeTracker-Team
  version: 1.0.0
---

# Timetracker UI

Legt fest, wie die Oberfläche aussehen und sich anfühlen soll — als Ergänzung
zu den `shadcn-svelte`- und `svelte5`-Skills, die die Komponenten-Mechanik
abdecken. Für Utility-Syntax siehe den `tailwind-v4`-Skill.

## When to Use

Use this skill when the user:
- neue Komponenten oder Seiten gestaltet
- Farben, Abstände, Radien oder Zustände (hover/active/disabled) anfasst
- Anwender-sichtbare Texte formuliert oder überarbeitet

Do NOT use this skill for:
- reine Logik-/State-Änderungen ohne sichtbare UI-Auswirkung

## Instructions

### Step 1: Theme respektieren, nicht erweitern

- [src/app.css](src/app.css) ist die einzige Quelle für Design-Tokens
  (`--background`, `--primary`, `--radius` usw.) — keine Farben/Radien
  hart codieren, immer die vorhandenen CSS-Variablen bzw. die daraus
  generierten Tailwind-Utilities (`bg-background`, `text-foreground`, …)
  verwenden.
- Basis ist das unveränderte shadcn-svelte-`neutral`-Theme
  ([components.json](components.json): `"baseColor": "neutral"`) — keine
  eigene Markenfarbe. Eine neue Akzentfarbe ist eine bewusste
  Design-Entscheidung, kein Nebenbei-Fix in einer einzelnen Komponente.
- Light/Dark läuft über die Klasse `.dark` plus `@custom-variant dark`.
  Neue Farbwerte immer für beide Modi in `:root` und `.dark` eintragen,
  nie nur für einen.
- bits-ui-Zustände (von shadcn-svelte-Komponenten genutzt) laufen über die
  projekteigenen Varianten `data-active`/`data-checked`/`data-unchecked`,
  nicht über rohe `data-[state=...]`-Selektoren.

### Step 2: Projekteigene Basis-Regeln kennen

Diese Regeln liegen im `@layer base` in app.css und gelten global, nicht pro
Komponente wiederholen:

- Anklickbares bekommt automatisch `cursor: pointer` (Buttons, `role=button`,
  `summary`) — keine Utility-Klasse dafür nötig, `disabled:cursor-not-allowed`
  schlägt sie bei Bedarf.
- Horizontales Scrollen ohne sichtbaren Balken: Utility `scrollbar-lose`
  (z. B. für Tab-Leisten auf schmalen Displays).
- Seitlicher Safe-Area-Abstand (`env(safe-area-inset-*)`) ist bereits global
  auf `body` gesetzt — nicht pro Container erneut hinzufügen.

### Step 3: Anwender-sichtbare Texte

- Zielgruppe hat kein technisches Vorwissen: Architektur- und
  Technik-Vokabular raus ("Passkeys hängen an der Adresse des Servers" ist
  schlecht).
- Fachbegriffe der Domäne bleiben (Arbeitszeitgesetz, LOGA-Bezug bei
  Pausenregeln) — das ist kein Jargon-Problem für diese Zielgruppe.
- UI-Texte sind Deutsch (siehe Namenskonvention-Regel: Deutsch nur in
  Kommentaren/UI-Texten, nie in Code-Namen).

## Examples

**Example:** Neuer Status-Hinweis in einer Karte
User says: "Zeig einen Warnhinweis, wenn die Synchronisierung fehlschlägt"
Actions:
1. `bg-destructive`/`text-destructive-foreground` (oder `muted`, je nach
   Dringlichkeit) statt eigener Farbwerte verwenden
2. Text ohne Technik-Jargon formulieren ("Der Abgleich ist fehlgeschlagen",
   nicht "Sync-Fehler: 401")
3. Prüfen, ob die Karte in beiden Themes (hell/dunkel) lesbar bleibt
Result: Konsistent mit bestehenden Karten, kein neuer Farbwert nötig

## Troubleshooting

**Error:** Komponente sieht im Dark Mode falsch aus
**Cause:** Farbe direkt gesetzt statt über Token, oder Token nur in `:root`
ergänzt
**Solution:** Token in beiden Blöcken (`:root` und `.dark`) in app.css
eintragen, Komponente über die Tailwind-Utility referenzieren
