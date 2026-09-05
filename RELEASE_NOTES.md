## TimeTracker v0.9.1 – Bugfix-Release

<!--
  Diese Datei UEBERSCHREIBT die aus den Commits generierten Release-Notes
  (.github/workflows/release.yml). Die erste Zeile muss den Tag des Releases
  nennen, sonst bricht der Workflow ab - so kann kein Release mehr mit dem Text
  der Vorversion herausgehen.

  Wer die Handfassung nicht mehr braucht: Datei loeschen, dann uebernimmt der
  Generator (gruppiert nach Neue Funktionen / Fehlerbehebungen / Sonstiges und
  haengt das vollstaendige Changelog an).
-->

Dieses Update behebt wichtige Probleme bei der Konto-Isolation und verbessert das Onboarding im Web.

### Fehlerbehebungen & Verbesserungen

- **Strikte Kontoisolation & Bereinigung:**
  - `clearAccountData()` bereinigt nun vollständig alle lokalen Einstellungs- und Berichtsdateien bei Kontowechsel oder Neuregistrierung im Browser.
  - Verhindert zuverlässig, dass Altdaten eines früheren Nutzers in ein neu registriertes Konto oder einen neuen Server übertragen werden.
  - Zurücksetzen des In-Memory-Outbox-Puffers beim Abmelden (`stopTracking()`).

- **Web-Onboarding & Einrichtung:**
  - Nach der Neuregistrierung im Web öffnet sich bei Überspringen der Desktop-Kopplung nun automatisch der interaktive Einrichtungs-Assistent (OnboardingWizard).
  - Web-Registrierung übergibt keine alten Namen mehr vorab an den Server.

- **Passkey- & Favicon-Assets:**
  - Optimierte Favicon- und App-Icon-Assets für Passwort-Manager (z. B. 1Password, Bitwarden) und Apple-Touch-Icons.

---

## TimeTracker v0.9.0 – Das große Server- & Sync-Update

Mit dieser Version wird TimeTracker um einen optionalen, Ende-zu-Ende verschlüsselten Server erweitert: Arbeitszeiten und Aktivitäten lassen sich jetzt nahtlos zwischen Desktop-App und Web-Browser synchronisieren.

### Die wichtigsten Neuerungen

- **Ende-zu-Ende verschlüsselte Synchronisation:**
  - Zero-Knowledge: Sämtliche Einträge, Notizen und Aktivitäten werden direkt auf dem Endgerät mit AES-GCM verschlüsselt. Der Server speichert ausschließlich Chiffrate.
  - Automatischer Hintergrundabgleich im Millisekundenbereich.

- **Web-App & PWA:**
  - TimeTracker lässt sich nun ohne Installation direkt im Browser auf jedem Endgerät nutzen.

- **Passkey- & WebAuthn-Authentifizierung:**
  - Sichere, passwortlose Anmeldung via Windows Hello, Touch ID oder FIDO2-Sicherheitsschlüssel.