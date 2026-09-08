# Was offen ist

Stand 2026-09-08, Branch `feat/passkey-vault`. Nichts davon ist deployt.

Was dauerhaft gilt, steht in [`../AGENTS.md`](../AGENTS.md); abgeschlossene
Vorhaben stehen in der Commit-History, nicht als Datei daneben.

## Beobachten, nicht jagen

`npm audit` meldet fünf Einträge im Produktivbaum — alle mit derselben Ursache:
`cookie <0.7.0` (GHSA-pxg6-pf52-xh8x, low) über `@sveltejs/kit`, an dem auch
`bits-ui`, `runed` und `svelte-toolbelt` hängen. Die neueste Kit-Fassung hängt
weiterhin daran; der angebotene „Fix" wäre ein Downgrade auf Kit 0.0.30, also
keiner. Ausnutzbar ist es hier nicht: die Anwendung setzt genau ein Cookie mit
festem Namen und selbst erzeugtem Wert, nichts davon kommt aus einer Anfrage.

## Vor dem Release

- **Repository neu aufsetzen** statt eines GitHub-Support-Tickets. Die alten
  Commits von vor dem History-Rewrite sind weiterhin per SHA abrufbar, und
  GitHub räumt das nur bei Credentials weg — Namen und Domains fallen nicht
  darunter. Plan und Sicherung liegen unter
  `~/TimeTracker-migration-backup/PLAN.md` (217 Assets, 45 Releases, Wiki, saubere
  History als Bundle). Erst danach
  `~/TimeTracker-PRE-REWRITE-backup.bundle` löschen.

## Bewusst so gelassen

`listEntryYears` (`src/lib/store.ts`) liest auf dem Rechner jede Monatsdatei nur
zum Zählen. Im Browser läuft es nicht mehr (hängt an `isTauri()`), auf dem
Rechner steht die exakte Zahl nirgends sonst, und der Aufruf fällt nur bei
offenem Systemtab an.
