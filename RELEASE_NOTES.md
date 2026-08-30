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