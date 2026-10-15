# Was offen ist

Stand 2026-09-30, Branch `dev`, vor dem Release 1.1.0.

Was dauerhaft gilt, steht in [`../AGENTS.md`](../AGENTS.md); abgeschlossene
Vorhaben stehen in der Commit-History, nicht als Datei daneben.

## Arbeitszeit-Check, Kleinigkeiten nach dem Umbau vom 2026-10-15

- `makeVerdict` sagt im Fall „nicht mehr zu halten" noch „entlastet ist das
  Fenster erst am …" – Bestandstext mit Technik-Vokabel, besser „der
  24-Wochen-Schnitt".
- `arbzgMonths` lädt zwölf Monate zurück; seit `prepare()` nur noch 168 Tage
  braucht, reichten sechs. Spart Ladezeit, ändert keine Zahl.
