# Aufraeumung September 2026 — Historie

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
  `AGENTS.md` verboten; jetzt "Vault-Schluessel" und "Image". Zwei
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

Die Regeln, die daraus dauerhaft gelten, stehen in [`../AGENTS.md`](../AGENTS.md).
