# Kommentar- & Text-Aufraeumung — Fortschritt

Laufende Aufgabe: jede Datei einmal durchgehen, Kommentare und Anwender-Texte
pruefen, fixen, committen. Diese Datei ist der Fortschritts-Tracker — sie liegt
im Repo, damit jede Maschine (git pull) genau hier weitermachen kann.

## Stand 2026-09-05

Ein Durchlauf ueber den ganzen Baum, drei Commits:

- **Bezeichner.** `#warteschleife`, `#bestaetigung`, die Log-Felder `grund`
  und `geschlossen`, vier Rust-Testnamen in `secret.rs` und rund ein Dutzend
  deutsche Locals in Tests sind umbenannt. Ein Skript hat dafuer alle
  Bezeichner in Wortteile zerlegt und gegen ein Woerterbuch geprueft, statt
  nach bekannten Wortstaemmen zu suchen.
- **Storytelling.** Elf Kommentare erzaehlten die Vorgeschichte statt den
  Grund. Der sachliche Teil steht jeweils noch, die Vorher-Nachher-Haelfte ist
  weg. In `TrackingPanel.svelte` lag zusaetzlich ein verwaistes JSDoc.
- **Vokabular.** "Tresorschluessel" (45x) und "Abbild" (5x) sind laut
  `AI_GUIDELINES.md` verboten; jetzt "Vault-Schluessel" und "Image". Zwei
  sichtbare Texte dabei umgeschrieben statt nur ersetzt.

**Beides frueher hier Geflaggte ist erledigt.** Der Satz in
`PasskeyPanel.svelte` ("Erstelle dazu dein Konto im Browser") steht nicht mehr
im Code. Die personenbezogenen Testdaten sind weg - und zwar aus der ganzen
History, siehe unten.

**Bewusst stehen geblieben** (Ablagenamen, kein Code-Vokabular): `kontoKennung`
und `bestandGehoertZu` in alten `device.json`, die Schluessel in
`LEGACY_FLAG_KEYS`, `gueltigTage` im alten Wire-Format der Invites und der
IndexedDB-Name `tresor` in `testing/legacyKeyStore.ts`.

## History-Rewrite 2026-09-05

Die Firmendomain und der Name eines Kollegen lagen seit `7c92f69` in
`teamReport.test.ts` - also unterhalb von `main`, nicht erst in einem Branch.
Ein Fix im Kopf-Commit haette sie in der History stehen lassen. Deshalb
`git filter-repo` ueber ALLE Refs, 591 Commits, in drei Durchlaeufen:

1. Firmendomain -> `firma.de`, Kollegenname -> "Bernd Mueller".
2. Test-Persona "Joel Klein" -> "Anna Meier" (auch in `teamReport.ts`,
   `time.test.ts`, `report.test.ts` und im README-Beispiel).
3. Autor- und Committer-Adresse: 207 bzw. 214 Commits trugen die
   **Firmen-Mailadresse** - `--replace-text` fasst Commit-Metadaten nicht an,
   dafuer brauchte es `--mailmap`. Jetzt durchgehend `joel_klein@me.com`; der
   Autorname bleibt, es ist das eigene Repo. Dazu drei Restspuren: die
   private Beispiel-Serveradresse im Onboarding, ein Home-Pfad in einem
   Fixture und ein versehentlich eingecheckter `file:///`-Link im README.

4. Die Personalnummer aus den Testdaten, dazu der Nachname im Fixture von
   `timeReport.test.ts` - der wurde in Durchlauf 2 sonst inkonsistent
   (Erwartung "Anna Meier", Fixture baute "Anna Klein").

Danach `--force` auf `main`, `feat/passkey-vault`, `fix/passkey-vault-wrap`
und `feat/cloud-sync`. Backup der alten History vorher als Bundle unter
`~/TimeTracker-PRE-REWRITE-backup.bundle`.

**Was ein Rewrite NICHT leistet:** GitHub haelt die alten Commits unter ihrer
SHA-URL weiter abrufbar, bis der Support sie loescht - das ist ein eigenes
Ticket. Wer vorher geklont oder geforkt hat, hat sie ohnehin.

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
