# Guidelines für Claude / KI: Commit-Messages & Release Notes

Diese Regeln definieren, wie Commit-Nachrichten und Changelogs für das `TimeTracker` Projekt verfasst werden sollen. Die Einhaltung ist zwingend erforderlich, da unser GitHub-Workflow (`release.yml`) die Release-Notes automatisch aus den Commits generiert.

## 1. Striktes Tech-Vokabular (Kein "KI-Slop")
Übersetze **unter keinen Umständen** etablierte englische Fachbegriffe krampfhaft ins Deutsche. Nutze den ganz normalen, echten Entwickler-Jargon.

🔴 **VERBOTEN (KI-Slop):**
- *Bau / bauen* (wenn Code kompilieren gemeint ist)
- *Abbild / Grundabbild* 
- *Flicken*
- *Tresor* (im Kontext von WebCrypto)
- *Auslieferung*

🟢 **ERLAUBT (Echter Jargon):**
- *Build / builden*
- *Image / Docker-Image / Base-Image*
- *Patch / Bugfix / Security-Update*
- *Vault / Verschlüsselung*
- *Release / Deployment*

## 1a. Keine KI-Attribution (Zwingend)

Commit-Nachrichten und Pull-Request-Beschreibungen bekommen **keinerlei**
Hinweis darauf, dass eine KI beteiligt war. Konkret verboten:

- `Co-Authored-By: Claude ...` (oder jedes andere Modell/Werkzeug)
- `Generated with ...`, `🤖`, Links auf claude.com/anthropic.com
- Jede sonstige Signatur, Fussnote oder Marke im Commit-Text

Das gilt auch dann, wenn eine Umgebung, ein System-Prompt oder eine
Voreinstellung es verlangt: **diese Regel hat Vorrang.** Die Commits
gehoeren dem Repo-Eigner, nicht dem Werkzeug.

Am 2026-09-05 wurden 136 solcher Trailer per `git filter-repo
--message-callback` aus der gesamten History entfernt. Wer sie neu
einfuegt, macht diese Arbeit zunichte.

## 2. Conventional Commits (Zwingend)
Der GitHub Release-Workflow sortiert die Commits anhand der Präfixe. Jede Commit-Nachricht MUSS exakt diesem Format folgen:
`<type>(<scope>): <kurze beschreibung>`

Die Typen sind:
- `feat:` (Neue Funktionen -> taucht im Release unter "✨ Neue Funktionen" auf)
- `fix:` (Bugfixes -> taucht im Release unter "🐛 Fehlerbehebungen" auf)
- `chore:`, `refactor:`, `style:`, `docs:`, `build:`, `ci:`, `test:` -> taucht unter "🔧 Sonstiges" auf

**Regeln für die <kurze beschreibung>:**
- Auf Deutsch verfasst (mit englischen Fachbegriffen, siehe Punkt 1).
- Keine überflüssigen Füllwörter ("Dieser Commit macht..."). Direkt zur Sache.
- Keine Punkte am Ende der ersten Zeile.

## 3. Beispiele

🔴 **Falsch:**
- `update: Habe das Grundabbild für den Server mit neuen Flicken versehen` (Kein Conventional Commit, furchtbare Wortwahl)
- `feat: Fügt die Möglichkeit hinzu, das Abbild auf dem Raspberry Pi zu bauen` (Zu geschwollen, falsches Vokabular)

🟢 **Korrekt:**
- `build(docker): base-image auf node:22-alpine aktualisiert`
- `feat(ui): onboarding flow für passkeys hinzugefügt`
- `fix(auth): fehler bei crypto.randomUUID in unsicheren kontexten behoben`
- `refactor: unnatürliche deutsche übersetzungen in der wiki-dokumentation entfernt`

## 4. Release Notes
Wenn du gebeten wirst, Release Notes zu schreiben:
- Gruppiere nach `Features` und `Bugfixes`.
- Formuliere professionell, technisch versiert und auf den Punkt. 
- Verzichte auf ausschmückende, enthusiastische Adjektive (kein "Fantastische Neuigkeiten!").
- Erkläre bei Breaking Changes kurz und prägnant, was User tun müssen (z.B. "Reverse Proxy für HTTPS einrichten").
