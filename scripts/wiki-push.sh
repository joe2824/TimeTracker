#!/usr/bin/env bash
# Die Seiten aus wiki/ ins GitHub-Wiki schieben.
#
# Das Wiki-Repo entsteht bei GitHub NICHT über die API, sondern erst, wenn
# einmal eine Seite über die Weboberfläche angelegt wurde. Danach ist es ein
# gewöhnliches Git-Repo und dieses Skript hält es aktuell.
set -euo pipefail

REPO="${1:-joe2824/TimeTracker}"
QUELLE="$(cd "$(dirname "$0")/../wiki" && pwd)"
ARBEIT="$(mktemp -d)"
trap 'rm -rf "$ARBEIT"' EXIT

if ! git ls-remote "https://github.com/${REPO}.wiki.git" >/dev/null 2>&1; then
  cat >&2 <<HINWEIS
Das Wiki-Repo gibt es noch nicht.

Einmalig im Browser anlegen (eine API dafür gibt es nicht):
  https://github.com/${REPO}/wiki  ->  "Create the first page"  ->  Save

Danach dieses Skript erneut starten.
HINWEIS
  exit 1
fi

git clone "https://github.com/${REPO}.wiki.git" "$ARBEIT/wiki" --quiet

# Alte Seiten weg, aktuelle rein: so verschwinden auch umbenannte Seiten,
# statt als Leiche stehen zu bleiben.
find "$ARBEIT/wiki" -maxdepth 1 -name '*.md' -delete
cp "$QUELLE"/*.md "$ARBEIT/wiki/"

cd "$ARBEIT/wiki"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "Wiki ist schon aktuell."
  exit 0
fi

git add -A
git status --short
git commit -q -m "docs: Wiki aus wiki/ aktualisiert"
git push --quiet
echo "Wiki aktualisiert: https://github.com/${REPO}/wiki"
