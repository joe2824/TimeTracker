# TimeTracker

Desktop-Zeiterfassung für Projektzeiten mit Monatsbericht per E-Mail an den/die Vorgesetzte:n.
Läuft im Hintergrund (Tray), erfasst Zeiten per Timer und erstellt am Monatsende eine fertige
Stundenübersicht.

Gebaut mit **Tauri 2**, **SvelteKit** (SPA, adapter-static), **Svelte 5 Runes**, **TypeScript**
und **Tailwind CSS v4** / shadcn-svelte.

## Download

Neueste Version (Windows-Installer): **<https://github.com/joe2824/TimeTracker/releases/latest>**


Die App aktualisiert sich anschließend selbst: gesucht wird beim Start und danach **stündlich**.
Ein Fund meldet sich als Hinweis mit „Installieren" und bleibt als Pfeil-Symbol in der Kopfzeile
stehen, bis er erledigt ist – der Hinweis kommt je Version nur einmal, und erst wenn das Fenster
auch zu sehen ist (beim Autostart läuft es versteckt). Von Hand geht es weiterhin über
Einstellungen → „Nach Updates suchen".

## Features

- **Timer-Tracking** – Aktivität wählen, Timer starten/stoppen, „Heute"-Übersicht mit allen
  Zeiten des Tages und einer Bilanz: erfasst, Pausenabzug, Arbeitszeit.
- **Aktivitäten** – importieren (Textfeld/Datei), umbenennen, sortieren (Drag & Drop), Favoriten,
  ausblenden, archivieren, eigene **Farbe** und globaler **Tastenkürzel** je Aktivität.
- **Einträge** – Tagesraster pro Monat; Eintrag mit gekoppelten Feldern **Von / Bis / Stunden**
  (eines wird aus den anderen berechnet); **Urlaub/Abwesenheit als Zeitraum** (halbe/ganze Tage,
  Wochenenden überspringen); Schnelleingabe; Kalender-Import.
- **Zeitwächter-Abgleich** – den Zeitwirtschaftsreport (.xlsx) aus LOGA/Scout per Drag & Drop
  einlesen und sehen, an welchen Tagen Zeit fehlt; fehlende Zeiten lassen sich in einem Rutsch
  einem Projekt zuordnen, siehe [Zeitwächter-Abgleich](#zeitwächter-abgleich).
- **Bericht** – Monatsaggregation je Aktivität, Rundung, HTML-Vorschau, „HTML kopieren" und
  **Outlook-Entwurf** erstellen.
- **Tray-Menü (OneDrive-Stil)** – Links-Klick öffnet Schnellstart: laufender Timer + Stop,
  Favoriten und zuletzt benutzte Timer; Live-Tooltip mit laufender Zeit.
- **Leerlauf-Erkennung** – nach X Minuten ohne Eingabe fragt die App: Zeit behalten, Leerlauf
  abziehen oder Eintrag verwerfen.
- **Auto-Stop-Warnung** und **Pomodoro/Pausen-Erinnerung** (konfigurierbar).
- **Globaler Start/Stop-Hotkey** für den zuletzt benutzten Timer.
- **Befehlspalette** (Cmd/Ctrl+K) – Timer per Fuzzy-Suche starten/stoppen, Tabs wechseln.
- **Automatischer Pausenabzug** – ab 4 h Tagesarbeitszeit 15 Minuten, ab 6 h insgesamt 45; wie
  LOGA es rechnet. Abschaltbar, siehe [Automatischer Pausenabzug](#automatischer-pausenabzug).
- **Auswertung** – Soll/Ist-Saldo, Stunden je Aktivität und Jahres-Heatmap der gearbeiteten
  Tage. Rein lokal, kein Teil der E-Mail; in den Einstellungen abschaltbar.
- **Arbeitszeit-Check** – schätzt nach dem Arbeitszeitgesetz, ob der 24-Wochen-Schnitt von 8 h
  zu reißen droht und um wie viel man je Arbeitstag herunter müsste. Auf Wunsch mit kurzem
  Hinweis auf der Tracking-Seite. Ebenfalls lokal und abschaltbar, siehe
  [Arbeitszeit-Check](#arbeitszeit-check).
- **Chef-Modus** (optional, in den Einstellungen einschaltbar und dauerhaft gespeichert) –
  Tab „Team“: prüft im Outlook-Posteingang, wer seinen Monatsbericht geschickt hat und wer
  nicht, exportiert die Liste als **CSV** und erstellt eine **Erinnerung an die Fehlenden** als
  Outlook-Entwurf. Reiner Lesezugriff – es wird keine Mail verschoben, markiert oder gelöscht.
  Stunden wertet der Chef-Modus bewusst **nicht** aus, siehe [Chef-Modus](#chef-modus).
- **Autostart** mit dem System (versteckt im Tray), **Updater**, Datei-basierte Persistenz.

## Regeln

- Eine **Ganztags-Abwesenheit** und Projektzeit am selben Tag schließen sich aus; ein
  **halber Urlaubstag** darf neben Projektzeit liegen.
- Tage mit Ganztags-Abwesenheit werden im Bericht ohne Projektzeiten gewertet.

### Automatischer Pausenabzug

Standardmäßig aktiv, abschaltbar unter **Einstellungen → Arbeitszeit → „Pause automatisch
abziehen"**. Ab **4 h** Tagesarbeitszeit werden **15 Minuten** abgezogen, ab **6 h** insgesamt
**45** – dieselbe Regel, die LOGA auf die Anwesenheit anwendet. Damit rechnet die App auf
derselben Grundlage wie der Zeitwirtschaftsreport, auch wenn der Timer über die Mittagspause
weiterläuft.

Wichtig dazu:

- Geschwellt wird auf der **Tagessumme** aller Projektzeiten, nicht je Eintrag: zwei Einträge
  von je 3,5 h ergeben zusammen 7 h und damit 45 Minuten Abzug.
- Der Abzug verteilt sich **anteilig** auf die Aktivitäten des Tages, ist also unabhängig von
  deren Reihenfolge.
- **Abwesenheiten sind ausgenommen** – auf einen Urlaubstag gibt es keine Pause.
- Die **erfassten Einträge bleiben unverändert**; abgezogen wird erst beim Aufsummieren. Der
  Schalter lässt sich damit jederzeit zurücknehmen, ohne dass Zeiten verloren gehen.
- Der Abzug wirkt auf Tagessummen, **Bericht** (und damit die E-Mail) und Auswertung. Die
  Verifikations-Zeile im Tab „Bericht" weist ihn getrennt aus.

### Arbeitszeit-Check

Standardmäßig aktiv, abschaltbar unter **Einstellungen → Bericht → „Arbeitszeit-Check
anzeigen"**. Die Karte steht im Tab **Bericht** unter der Auswertung und geht **nicht** in die
E-Mail.

Im Mittelpunkt steht § 3 Abs. 1 Satz 2 ArbZG: Ein Tag darf bis zu **10 h** haben, im
**Durchschnitt über 24 Wochen** aber höchstens **8 h werktäglich**. Das ist die Grenze, in die
man hineinläuft, ohne es zu merken – und weil das Fenster **rollt**, steigt der Schnitt nicht
einfach, sondern hat einen Verlauf: alte schwere Tage fallen hinten heraus, während vorne neue
hineinlaufen. Die Karte simuliert diesen Verlauf Tag für Tag und beantwortet drei Fragen:

1. **Wo stehe ich?** Schnitt und Puffer im Fenster, das heute endet.
2. **Wenn es so weitergeht?** Aus den letzten **16 Wochen** — zwei Dritteln des
   Ausgleichszeitraums, umschaltbar auf 4, 8 oder 12 — wird ein Tempo in Stunden je Arbeitstag
   abgeleitet und 26 Wochen weit fortgeschrieben. Bewusst träge: der Umkehrpunkt liegt bei
   normaler Arbeit Monate voraus, es ist also reichlich Zeit gegenzusteuern, und dann wäre ein
   nervöser Maßstab der falsche. Vier Wochen schlagen schon bei zwei zufällig langen Wochen
   aus, und wer diese Warnung zweimal gesehen hat, sieht die dritte nicht mehr an.

   Die Kehrseite: je näher der Bezugszeitraum an die 24 Wochen rückt, desto mehr nähert sich
   das Tempo dem Fensterschnitt selbst an — die Prognose wird flacher und sagt im Grenzfall nur
   noch „so wie bisher bleibt es, wie es ist“. Wer den Verdacht hat, gerade laufe eine heiße
   Phase, schaltet auf **4 Wochen** und sieht den ungeglätteten Stand.
3. **Bis wann kann ich es noch drehen?** Der **Umkehrpunkt**: der späteste Tag, an dem man
   anfangen kann herunterzugehen und trotzdem unter der Grenze bleibt. Gerechnet wird der
   günstigste Fall — bis dahin im aktuellen Tempo, danach gar nichts mehr.

Die Kurve im Diagramm **steigt**, wenn das aktuelle Tempo über dem bisherigen Schnitt liegt:
das rollende Fenster tauscht Woche für Woche ältere, kürzere Tage gegen Tage dieses Tempos.
Bleibt es dabei, endet der Schnitt genau beim aktuellen Tempo. Das steht als Satz unter dem
Diagramm, weil eine steigende Linie sonst wie ein Trend aussieht statt wie eine Folge der
Annahme.

#### Wann gewarnt wird

Nicht danach, **ob** die Grenze überschritten ist, sondern danach, **ob es noch umkehrbar
ist**. Ein paar Minuten über acht Stunden sind kein Notfall: das Fenster rollt, und wer kürzer
tritt, holt es wieder ein. Ernst wird es erst, wenn Kürzertreten nicht mehr reicht. Die Stufen
richten sich deshalb nach dem Umkehrpunkt:

| Lage | Anzeige |
|---|---|
| Kein Umkehrpunkt nötig, Kurve bleibt unter 8 h | „Im grünen Bereich“ · neutral |
| Kurve streift die 8 h | „Dicht an der Grenze“ · neutral |
| Umkehrpunkt weiter als eine Woche entfernt | „Umkehrpunkt in etwa X Wochen“ · neutral |
| Umkehrpunkt in **≤ 7 Tagen** | „Gegensteuern in X Tagen“ · **rot** |
| Umkehrpunkt verstrichen | „Nicht mehr aufzuhalten“ · **rot** |
| Schnitt bereits über 8 h | „Grenze bereits gerissen“ · **rot** |

**Farbe heißt Handlungsbedarf** — und sonst nichts, auch bei den Kennzahlen darunter. Solange
der Umkehrpunkt in der Ferne liegt, leuchtet auch ein Schnitt von 8:00 h nicht rot; er ist ja
einzuholen. Wo gewarnt wird, sagt die Zeile darunter zuerst, worauf sich die Warnung stützt:
nebeneinander gelesen wirkten sonst eine rote Warnung und ein „gesetzlich unkritisch“ wie ein
Widerspruch.

Fristen stehen auf **Wochen gerundet und mit „etwa“**. Nahe der Schwelle nähert sich die Kurve
fast tangential; ein Tempounterschied von einer Viertelstunde verschiebt den Tag um Wochen.
Aus demselben Grund gilt eine Toleranz von drei Minuten je Werktag.

„Höchstens X h je Arbeitstag“ ist ein **Tempo**, keine Tagesration: der Wert wird über Fenster
ab vier Wochen Vorlauf bestimmt. In den ersten vier Wochen kann der Schnitt die Grenze deshalb
streifen, obwohl man sich daran hält — diese Fenster sind von bereits gearbeiteten Stunden
bestimmt. Über sechzig zufällig erzeugte Halbjahre gemessen lag die größte Überschreitung bei
elf Minuten; ein Test deckelt sie bei einer Viertelstunde.

#### Zwei Lesarten

Gerechnet wird **8 h × Werktage**, und Werktage sind nach dem Gesetz **Mo–Sa**. 24 Wochen
ergeben so 144 Werktage = 1152 h Budget; bei 7,5 h an fünf Tagen kommen davon rund 900 h
zusammen. Die gesetzliche Grenze ist damit für eine normale Fünf-Tage-Woche **praktisch
unerreichbar** – man müsste ein halbes Jahr lang 48 h/Woche arbeiten.

Deshalb zeigt die Karte beides:

- **gesetzlich (Mo–Sa)** – die Rechtslage, meist weit im Grünen.
- **streng (nur deine Arbeitstage)** – 120 statt 144 Werktage. Keine Gesetzeslage, sondern der
  **Frühwarnwert**; nur diese Zahl warnt früh genug, um noch etwas ändern zu können. Die
  Empfehlung beruht auf ihr und sagt das auch.

#### Hinweis beim Tracking

Getrennt schaltbar unter **Einstellungen → Bericht → „Hinweis beim Tracking"** (standardmäßig
an). Oben auf der Tracking-Seite erscheint dann **eine** Zeile, die in den Tab „Bericht“
führt und dort direkt zur Karte scrollt – aber nur, wenn tatsächlich etwas zu tun ist, also
wenn der Umkehrpunkt in Reichweite ist. Alles davor bleibt der Karte vorbehalten: eine Dauerwarnung
auf der meistgesehenen Seite liest nach einer Woche niemand mehr, und dann fällt auch die
nicht mehr auf, die etwas will.

Zwei weitere Bedingungen, damit der Hinweis nicht lügt: Er wartet, bis **alle zwölf Monate
geladen** sind (währenddessen sähe er nur den laufenden Monat und meldete Vielarbeitern
zuverlässig einen Fehlalarm), und er verlangt **mindestens acht Wochen** Erfassung. Die Karte
darf über eine kürzere Basis rechnen, weil sie sie ausweist und weil man sie aufsucht — ein
Hinweis, der von selbst erscheint, darf das nicht.

#### Was sonst geprüft wird

Unter der Prognose stehen die Tagesregeln: **> 10 h** (§ 3, die eine Grenze, die sich *nicht*
über den Durchschnitt ausgleichen lässt), **Ruhezeit unter 11 h** zwischen Feierabend und
nächstem Beginn (§ 5) und **Sonntagsarbeit** (§ 9). Ein Klick auf den Tag springt in die
Einträge.

#### Grenzen

- Erfasst werden **Projektzeiten, keine Stempelzeiten**. Das Ergebnis ist eine Annahme, kein
  Nachweis, und kein Rechtsrat – maßgeblich bleibt die Zeiterfassung des Arbeitgebers.
- **Ruhepausen (§ 4)** werden nur geprüft, wenn der [automatische
  Pausenabzug](#automatischer-pausenabzug) **abgeschaltet** ist. Ist er an, rechnet die App wie
  LOGA und zieht die Pause ohnehin ab; ein Timer, der über die Mittagspause durchläuft, dürfte
  dann keinen Verstoß auslösen. LOGAs Spalte „Verstoß Ruhepause" speist sich aus echten
  Stempeln und lässt sich in diesem Modus **nicht** vorhersagen.
- **Feiertage** kennt die App nicht. Ein gebuchter Feiertag ist eine Ganztags-Abwesenheit und
  fällt damit aus der Rechnung; an einem *ungebuchten* Feiertag gearbeitete Zeit erkennt der
  Check nicht als § 9-Fall.
- **Abwesenheiten** fallen aus dem Nenner, nicht nur aus dem Zähler – ein Urlaubstag bringt kein
  Acht-Stunden-Budget mit. Sonst ließe sich der Ausgleich schlicht erurlauben.
- Reicht die Erfassung keine 24 Wochen zurück, weist die Karte das aus und rechnet über den
  tatsächlich abgedeckten Zeitraum. Künftiger Urlaub ist nicht bekannt und wird als „keiner"
  angenommen – die vorsichtige Seite.

## Zeitwächter-Abgleich

In LOGA lässt sich über den Zeitwächter ein **Zeitwirtschaftsreport** („gesetzliche
Arbeitszeitverstöße") erzeugen und in Scout als `.xlsx` herunterladen. Diese Datei wird im Tab
**Einträge** auf die Karte „Zeitwächter-Report" gezogen (oder über einen Klick ausgewählt).

Der Report hat eine Zeile je Kalendertag. Verglichen wird die Spalte **„Arbeitszeit täglich"** –
die ist **netto**, LOGA hat die Pause dort bereits abgezogen (ab 4 h 15 Minuten, ab 6 h weitere
30). Ihr gegenüber steht, was in der App für den Tag erfasst ist. Abweichungen über
**15 Minuten** fallen auf:

| Status | Bedeutung |
|---|---|
| stimmt | Differenz innerhalb der Toleranz |
| fehlt | LOGA kennt Stunden, hier ist nichts erfasst |
| teilweise | hier ist weniger erfasst als LOGA kennt |
| zu viel | hier ist mehr erfasst als LOGA kennt |
| offen | in LOGA ist nur „Kommen" gestempelt – der Tag ist dort noch nicht fertig |

„Offen" ist typischerweise der laufende Tag: solange das Gehen fehlt, steht „Arbeitszeit täglich"
auf 0 oder auf einem Zwischenstand. Alles Erfasste sähe daneben nach *zu viel* aus, obwohl es LOGA
nur noch nicht erreicht hat – deshalb bleiben solche Tage in dieser Richtung stumm. Das gilt
absichtlich auch für ein **vergessenes Gehen in der Vergangenheit**: gegen eine 0 aus LOGA wäre
jede erfasste Stunde „zu viel", und die Meldung stünde für immer da, obwohl sie in LOGA zu klären
ist. Ein **Fehlbetrag** wird dagegen weiterhin gemeldet – was LOGA schon gutgeschrieben hat, wird
durch ein späteres Gehen nicht weniger.

Für jeden auffälligen Tag schlägt die App einen Nachtrag vor, der sich einer Aktivität zuordnen
lässt – einzeln oder für alle Tage auf einmal. Zwei Regeln stecken darin:

- **Tage ohne Stempel** mit genau einem halben oder ganzen Tagessatz sind Urlaub, Feiertag oder
  Gleittag – LOGA gibt alle drei identisch aus. Sie werden als **Abwesenheit** vorgeschlagen,
  nicht als Projektzeit.
- **Gestempelte Tage** werden zwischen „Erstes kommen" und „Letztes gehen" aufgefüllt. Bereits
  erfasste Zeiten bleiben unberührt, der Nachtrag legt sich in die freien Lücken.

Wie dabei gerechnet wird, hängt am [automatischen Pausenabzug](#automatischer-pausenabzug): ist
er **aktiv**, trägt der Nachtrag die **Anwesenheit** ein (also inklusive Pause, wie ein
durchlaufender Timer sie erfasst) und die App zieht sie anschließend ab. Ist er **aus**, spart
der Nachtrag stattdessen eine **Lücke in Höhe der Pause** um die Mittagszeit aus. Beides ergibt
am Ende die Stundenzahl aus dem Report – die LOGA-Zahl eins zu eins einzutragen wäre bei aktivem
Abzug zu wenig, weil sie den Abzug ein zweites Mal bekäme.

Zwei Sonderfälle, die der echte Report zeigt:

- Meldet LOGA **mehr Stunden, als zwischen Kommen und Gehen liegen** (nachgebuchte Zeiten,
  Dienstreise), reicht der Nachtrag über „Letztes gehen" hinaus – sonst ließe sich der Tag nie
  vollständig erfassen. Die Zeile weist diesen Teil **getrennt** aus („+1:35 h über die
  Stempelzeiten hinaus") und bietet eine **eigene Aktivitätsauswahl** dafür an, vorbelegt mit
  „Others" – solche Stunden gehören selten auf dasselbe Projekt wie der gestempelte Tag.
- Zieht LOGA an einem Tag **anders ab als die Hausregel** (gestempelte Zusatzpause,
  Korrekturbuchung), bleibt nach dem Nachtrag eine Differenz stehen. Sie wird *nicht* mit
  erfundener Anwesenheit aufgefüllt; die Zeile sagt stattdessen, wie viel LOGA dort abgezogen
  hat. Im vorliegenden Report betrifft das rund 11 % der gestempelten Tage.

Nachgetragene Einträge tragen die Notiz „Zeitwächter" und werden beim nächsten Abgleich als
*bereits nachgetragen* erkannt – ein zweiter Durchlauf erzeugt keine Dubletten. Die Verstoß-Spalten
des Reports (Ruhepause, > 10 h, Sonntags-/Feiertagsarbeit) erscheinen als Badge am jeweiligen Tag.

Der eingelesene Report bleibt unter `data/timereport-YYYY-MM.json` liegen und wirkt danach im Tab
**Einträge** weiter, auch ohne geöffneten Abgleich:

- In der **Tagesliste** trägt jeder abweichende Tag seine Differenz: `−1:15` in Amber, wo Zeit
  fehlt, `+0:45` in Blau, wo mehr erfasst ist als LOGA kennt (dieselben Farben wie im Abgleich).
- Im **Eintrags-Dialog** steht die Abweichung des Tages unter den Uhrzeiten, mit einem Knopf
  „1:15 h ergänzen" bzw. „0:45 h abziehen". Er setzt die Dauer **dieses** Eintrags so, dass der Tag
  auf die LOGA-Stunden kommt: „Von" bleibt stehen und „Bis" wandert – außer der Tag reicht dahinter
  nicht mehr, dann bleibt „Bis" stehen und „Von" rückt zurück. Über Mitternacht geht es dabei nie,
  sonst würden daraus zwei Einträge und der Tag bekäme nur den ersten. Gespeichert wird nichts; die
  Zeiten stehen anschließend im Formular und lassen sich noch anfassen.

Gerechnet wird dabei über die *übrigen* Einträge des Tages, nicht über die angezeigte Differenz:
so stimmt die Zahl auch, wenn im Dialog schon an den Zeiten gedreht wurde, und zweimal Drücken
verdoppelt nichts. Ist der [automatische Pausenabzug](#automatischer-pausenabzug) aktiv, zielt der
Knopf wie der Nachtrag auf die **Anwesenheit** – die LOGA-Zahl ist netto und bekäme den Abzug sonst
ein zweites Mal. Steht der Tag auch ohne diesen Eintrag schon zu voll, bleibt der Knopf weg: kürzer
als leer geht ein Eintrag nicht.

> Die heruntergeladene `.xlsx` enthält Personalnummer und Klarnamen. Sie wird nicht ins Repo
> übernommen (`.gitignore`); für die Tests liegt eine anonymisierte Fassung unter
> `src/lib/testing/`.

## Chef-Modus

Für Vorgesetzte, die die Berichte ihres Teams selbst per Mail bekommen. Einschalten unter
**Einstellungen → Chef-Modus** (Karte weit unten); dort werden auch das Team (Name + E-Mail) und
das Betreff-Merkmal hinterlegt. Der Schalter liegt in `settings.json` und bleibt damit über
Neustarts erhalten.

Im Tab **Team** wird ein Monat gewählt und „Berichte einlesen“ gedrückt. Gesucht wird im
Posteingang (auf Wunsch samt Unterordnern) vom Monatsersten bis zum 20. des Folgemonats nach
Mails mit dem Betreff-Merkmal. Das Ergebnis ist eine Liste: wer hat abgegeben (mit Datum), wer
fehlt. Dazu CSV-Export und eine Sammel-Erinnerung an die Fehlenden.

Zuordnung zur Person: E-Mail-Adresse, sonst Absendername, sonst der Name aus dem Betreff.

### Warum ohne Stunden?

Der Chef-Modus liest **nur den Briefumschlag** – Betreff und Empfangszeit –, nicht den Inhalt
der Mails. Das ist kein Versehen, sondern die Konsequenz aus dem, was Outlook per COM herausgibt.

Die Integration spricht COM, also das **klassische** Outlook (siehe unten) – derselbe Weg wie
beim Erstellen des Berichts-Entwurfs. Entwürfe *schreiben* ist unkritisch; vorhandene Mails
*lesen* schränken Sicherheitsrichtlinien dagegen ein. Ist der programmatische Zugriff gesperrt,
liefert das Objektmodell nur noch die Hülle: Betreff und Empfangszeit kommen an, **Body,
Absendername und -adresse bleiben leer** (`PropertyAccessor` ist dann `null`, `DownloadState`
meldet dauerhaft „nur Kopfzeilen“). Typische Auslöser sind die Gruppenrichtlinien unter
`HKCU\Software\Policies\Microsoft\Office\16.0\Outlook\Security`
(`adminsecuritymode = 3`, `promptoomaddressinformationaccess = 0`).

Daran ändert weder ein laufendes klassisches Outlook noch ein Sync, `Display()`, `GetInspector`
oder `Folder.GetTable()` etwas – das ist durchgemessen. Freigeben kann das nur die IT.

Eine Stundenauswertung wäre unter diesen Bedingungen dauerhaft leer. Statt einer Tabelle voller
Nullen zeigt der Chef-Modus deshalb nur, was wirklich ankommt. Die fertige Auswertung der
Stundentabellen liegt in Commit `90f6aa1`, falls der Zugriff je freigegeben wird.

## Datenablage

JSON im App-Daten-Ordner unter `data/`:

- `data/activities.json` – Aktivitäten (global)
- `data/settings.json` – Einstellungen (global)
- `data/entries-YYYY-MM.json` – eine Datei pro Monat
- `data/timereport-YYYY-MM.json` – eingelesener Zeitwirtschaftsreport, eine Datei pro Monat

Es wird nichts automatisch gelöscht. Unter „Einstellungen → Daten“ lassen sich ganze Jahre
gezielt entfernen (mit Rückfrage) – die Reports des Jahres gehen mit; Monate ohne Einträge
hinterlassen keine Datei.

## Entwicklung

Voraussetzungen: Node.js, Rust-Toolchain, Tauri-Systemabhängigkeiten
(siehe <https://v2.tauri.app/start/prerequisites/>).

```bash
npm install            # Abhängigkeiten + svelte-kit sync (prepare)
npm run tauri dev      # App im Entwicklungsmodus
npm run tauri build    # Release-Build inkl. Installer

npm run dev            # nur Frontend (Vite) im Browser
npm run check          # svelte-check (Typen/Templates)
npm test               # Vitest (reine Logik: time.ts, report.ts)
```

> Autostart und Tray-Verhalten funktionieren nur im installierten Release-Build, nicht im
> Dev-Binary.

### Der Server im Container

Das Abbild baut die GitHub-Action `.github/workflows/docker.yml` bei jedem
Versions-Tag und legt es in der GitHub-Registry ab — für `linux/amd64` und
`linux/arm64`, damit es auch auf einem Raspberry Pi läuft. `:latest` bekommen nur
stabile Versionen, nie eine Beta.

```bash
docker pull ghcr.io/joe2824/timetracker-server:latest
```

Selbst bauen und starten geht weiterhin mit der `docker-compose.yml` im Wurzelverzeichnis:
`.env` anlegen (Vorlage: `server/.env.example`), dann `docker compose up -d --build`.
Den ersten Verwalter ernennt man danach im Container:

```bash
docker compose exec timetracker node admin.mjs liste
docker compose exec timetracker node admin.mjs ernenne "<Name oder Kennung>"
```

### Einen Server voreinstellen

`DEFAULT_SERVER` trägt beim Bauen eine Serveradresse fest in die Anwendung ein.
Wer sie startet, muss dann nichts mehr eintippen — und findet unter der Adresse einen
kleinen Link, um doch einen eigenen Server zu nehmen.

```bash
DEFAULT_SERVER=https://tracker.example.de npm run tauri build
```

Im Entwicklungsmodus (`npm run tauri dev`, `npm run dev`) steht ohne Zutun
`http://localhost:3000` drin — der Server aus der `docker-compose.yml`.

In der GitHub-Action kommt der Wert aus der Repository-Variable `DEFAULT_SERVER`
(Settings → Secrets and variables → Actions → Variables). Kein Secret: die Adresse
steht ohnehin in jedem Build. Ist sie nicht gesetzt, fragt die Anwendung wie bisher.

### Releases

```bash
./scripts/release.sh          # stabile Version (fragt patch/minor/major)
./scripts/release.sh --beta   # Vorabversion, z. B. 0.8.0-beta.1
./scripts/release.sh 1.2.3    # feste Version
```

Unter Windows dasselbe mit `scripts\release.bat`. Das Skript hebt die Version in
`package.json`, `tauri.conf.json` und `Cargo.toml`, committet, taggt und pusht; der Tag
löst den Build in `.github/workflows/release.yml` aus.

**Zwei Kanäle:**

| | stabil | Beta |
|---|---|---|
| Tag | `v1.2.3` | `v1.2.3-beta.1` |
| GitHub-Release | normal | als Vorabversion markiert |
| Installer | NSIS + MSI | nur NSIS (MSI nimmt keine Vorabversionen) |
| Update-Manifest | `releases/latest/download/latest.json` | `releases/download/beta/latest.json` |

`releases/latest` lässt Vorabversionen aus – wer beim stabilen Kanal bleibt, sieht Betas
also nie. Das Beta-Manifest hängt an einem Release mit festem Tag `beta` und wird von
**jedem** Build überschrieben, auch von einem stabilen: wer Betas anhat, bekommt damit
immer den neuesten Stand und bleibt nicht auf einer Vorabversion sitzen.

Umgeschaltet wird in der App unter „Einstellungen → System → Vorabversionen (Beta)“. Der
Kanal steht fest, sobald das Updater-Plugin beim Start seine Konfiguration gelesen hat –
das Umschalten wirkt deshalb erst nach einem Neustart, den der Schalter direkt anbietet.

## Projektstruktur

```
src/
  routes/+page.svelte          App-Shell, Tabs, Watcher/Hotkeys
  lib/
    app.svelte.ts              zentraler Zustand (Svelte 5 Runes)
    store.ts                   Datei-Persistenz (tauri-plugin-fs)
    time.ts / report.ts        reine Logik (getestet)
    breaks.ts                  automatischer Pausenabzug (getestet)
    arbzg.ts                   Arbeitszeit-Check, 24-Wochen-Prognose (getestet)
    teamReport.ts              Chef-Modus: Abgabe-Kontrolle (getestet)
    xlsx.ts                    XLSX-Leser (ZIP + XML, ohne Paket; getestet)
    timeReport.ts              LOGA-Zeitwirtschaftsreport auswerten (getestet)
    timeReconcile.ts           Abgleich LOGA ↔ Einträge, Nachtrag planen (getestet)
    shortcuts.ts               globale Tastenkürzel
    reminders.ts               Erinnerungen (Notifications)
    watchers.svelte.ts         Leerlauf, Auto-Stop, Pomodoro, Tray-Tooltip
    components/                UI (Tracking, Einträge, Bericht, Aktivitäten, Einstellungen, …)
src-tauri/                     Rust: Tray, Idle-Query, Outlook, Plugins
```

## Empfohlenes IDE-Setup

[VS Code](https://code.visualstudio.com/) +
[Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) +
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
