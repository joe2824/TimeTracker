## TimeTracker v1.0.0 – Passkeys, verschlüsselte Ablage im Browser und einfachere Kopplung

<!--
  Diese Datei UEBERSCHREIBT die aus den Commits generierten Release-Notes
  (.github/workflows/release.yml). Die erste Zeile muss den Tag des Releases
  nennen, sonst bricht der Workflow ab - so kann kein Release mehr mit dem Text
  der Vorversion herausgehen.

  Wer die Handfassung nicht mehr braucht: Datei loeschen, dann uebernimmt der
  Generator (gruppiert nach Neue Funktionen / Fehlerbehebungen / Sonstiges und
  haengt das vollstaendige Changelog an).
-->

Dieses Release bringt die Verbindung zwischen Browser und Desktop-Anwendung sowie die Anmeldung per Passkey auf den letzten Stand. Die Registrierung ist nun für alle offen, und alle Daten liegen jetzt auch im Browser verschlüsselt.

### Neue Funktionen

- **Geräte verbinden, deutlich einfacher:** Ein Klick genügt – kein Code mehr zum Abtippen, die Verbindung läuft jetzt automatisch über einen Link. Vorher wird zur Sicherheit eine Sicherung der vorhandenen Daten angelegt.
- **Verschlüsselte Ablage auch im Browser:** Alle Daten liegen dort jetzt verschlüsselt, genau wie schon auf dem Rechner.
- **Zuverlässigeres Beenden:** Die Desktop-Anwendung gleicht beim Beenden noch einmal ab, damit nichts verloren geht.
