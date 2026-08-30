# Kommentar- & Text-Aufraeumung — Fortschritt

Laufende Aufgabe: jede Datei einmal durchgehen, Kommentare und Anwender-Texte
pruefen, fixen, committen. Diese Datei ist der Fortschritts-Tracker — sie liegt
im Repo, damit jede Maschine (git pull) genau hier weitermachen kann.

**Nebenbei, unabhaengig von dieser Aufgabe:** In PasskeyPanel.svelte lag zwischendurch
eine uncommittete lokale Aenderung (vermutlich User im Editor). Ein Satz dort
("Erstelle dazu dein Konto im Browser") wirkt falsch, weil die Karte nur sichtbar ist,
wenn das Konto schon verknuepft ist ("Erstelle" statt "Oeffne"). Nicht angefasst,
nur geflaggt.

**Ebenfalls nebenbei:** src/lib/teamReport.test.ts enthaelt in den Testdaten eine
echte Firmendomain ("firma.de") und einen Kollegennamen ("Bernd Müller").
Ausserhalb des Kommentar/Text-Scopes dieser Aufgabe, nicht angefasst, nur geflaggt.

## Regeln

**Code-Kommentare:**
- Kein Storytelling ("vorher war es X, jetzt Y, weil Z..."). Keine Romane.
- Wenn eine Funktion/Stelle einfach und offensichtlich ist: **kein Kommentar**.
- Wenn sie gross/komplex ist oder einen nicht offensichtlichen Grund hat
  (Bug-Vermeidung, Plattform-Eigenheit, Reihenfolge-Zwang): **ein kurzer Satz**,
  was/warum — keine Vorher-Nachher-Geschichte.
- Beispiel schlecht (real aus dem Code entfernt):
  > // Geschlossener Betrieb: der Code wird hier nur GEPRUEFT, nicht entwertet.
  > // Entwertet wird er erst, wenn das Konto wirklich entsteht - sonst verbraucht
  > // ein abgebrochener Versuch ihn ersatzlos.
- Wenn ein Kommentar nur wiederholt, was direkt darunter im UI-Text (z. B.
  Card.Description) schon steht: Kommentar loeschen, nicht doppelt pflegen.

**Anwender-sichtbare Texte (Labels, Beschreibungen, Fehlermeldungen):**
- Zielgruppe: normale Anwender ohne technisches Vorwissen. Kein Insider-/Dev-Jargon.
- Beispiel schlecht (real):
  > „Passkeys hängen an der Adresse des Servers – die Desktop-Anwendung hat keine.
  > Angelegt wird einer im Browser, sobald du ihn dort gekoppelt hast."
  So redet niemand mit normalen Nutzern. Umschreiben in klares, einfaches Deutsch.
- Business-/Fachbegriffe, die zur Zielgruppe gehoeren (z. B. Arbeitszeitgesetz,
  LOGA-Bezug bei Pausenregeln), sind KEIN Jargon-Problem — die App ist fuer
  deutsche Buero-Anwender mit genau diesem Kontext gebaut. Nur echtes
  Technik-/Architektur-Vokabular raus, das ein Endanwender nicht braucht.
