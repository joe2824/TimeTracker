#!/bin/bash
# Usage: ./scripts/release.sh [--beta] [version]
# Without version: auto-detects last release and prompts for patch/minor/major bump.
# With version:    uses the given version directly (1.2.3 or 1.2.3-beta.1).
# With --beta:     releases into the beta channel (prerelease, NSIS only).
# Bumps version in package.json, tauri.conf.json, Cargo.toml, commits, tags and pushes.
# The push of the v* tag triggers .github/workflows/release.yml (build + GitHub release).

set -euo pipefail

BETA=false
if [[ "${1:-}" == "--beta" ]]; then
    BETA=true
    shift
fi
VERSION="${1:-}"

# Last tag of a channel; empty if there is none yet.
#
# The "|| true" is load-bearing: with `set -o pipefail` a grep without a match
# fails the whole pipeline, and `set -e` would end the script right here. That is
# exactly the situation before the first beta – and, in a fresh clone without any
# tags, it made the "No version tags yet" branch below unreachable.
last_tag() {
    if [[ "$1" == "beta" ]]; then
        git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true
    else
        git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true
    fi
}

# ── Auto-detect version if not provided ──────────────────────────────────────
if [[ -z "$VERSION" ]]; then
    LAST_TAG=$(last_tag stable)
    if [[ -z "$LAST_TAG" ]]; then
        echo "No version tags yet — using current package.json version as base."
        LAST="$(grep '"version"' package.json | head -1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+')"
    else
        LAST="${LAST_TAG#v}"
    fi
    MAJOR=$(echo "$LAST" | cut -d. -f1)
    MINOR=$(echo "$LAST" | cut -d. -f2)
    PATCH=$(echo "$LAST" | cut -d. -f3)

    NEXT_PATCH="${MAJOR}.${MINOR}.$((PATCH + 1))"
    NEXT_MINOR="${MAJOR}.$((MINOR + 1)).0"
    NEXT_MAJOR="$((MAJOR + 1)).0.0"

    if [[ "$BETA" == true ]]; then
        # An unfinished beta series continues; its base is already ahead of the
        # last stable release. Starting over at -beta.1 would produce a version
        # that is OLDER than what testers already run, and the updater would
        # never offer it.
        LAST_BETA=$(last_tag beta)
        BETA_BASE="${LAST_BETA#v}"; BETA_BASE="${BETA_BASE%-beta.*}"
        if [[ -n "$LAST_BETA" ]] && [[ "$(printf '%s\n%s' "$LAST" "$BETA_BASE" | sort -V | tail -1)" == "$BETA_BASE" ]] \
           && [[ "$BETA_BASE" != "$LAST" ]]; then
            COUNT="${LAST_BETA##*-beta.}"
            VERSION="${BETA_BASE}-beta.$((COUNT + 1))"
            echo "Running beta series: ${LAST_BETA#v} → ${VERSION}"
        else
            echo "Last release: v${LAST} (no open beta series)"
            echo ""
            echo "  1) patch → ${NEXT_PATCH}-beta.1  (bug fixes)"
            echo "  2) minor → ${NEXT_MINOR}-beta.1  (new features, backward-compatible)"
            echo "  3) major → ${NEXT_MAJOR}-beta.1  (breaking changes)"
            echo "  4) custom"
            echo ""
            read -rp "Bump type [1-4]: " CHOICE
            case "$CHOICE" in
                1) VERSION="${NEXT_PATCH}-beta.1" ;;
                2) VERSION="${NEXT_MINOR}-beta.1" ;;
                3) VERSION="${NEXT_MAJOR}-beta.1" ;;
                4) read -rp "Version: " VERSION ;;
                *) echo "Invalid choice"; exit 1 ;;
            esac
        fi
    else
        echo "Last release: v${LAST}"
        echo ""
        echo "  1) patch → ${NEXT_PATCH}  (bug fixes)"
        echo "  2) minor → ${NEXT_MINOR}  (new features, backward-compatible)"
        echo "  3) major → ${NEXT_MAJOR}  (breaking changes)"
        echo "  4) custom"
        echo ""
        read -rp "Bump type [1-4]: " CHOICE
        case "$CHOICE" in
            1) VERSION="$NEXT_PATCH" ;;
            2) VERSION="$NEXT_MINOR" ;;
            3) VERSION="$NEXT_MAJOR" ;;
            4) read -rp "Version: " VERSION ;;
            *) echo "Invalid choice"; exit 1 ;;
        esac
    fi
fi

# ── Validate ──────────────────────────────────────────────────────────────────
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]]; then
    echo "Error: version must be semver (e.g. 1.2.3) or a beta (e.g. 1.2.3-beta.1)"
    exit 1
fi

# Channel and version have to agree – otherwise a "--beta" run would publish a
# stable release, or a plain run would tag a prerelease that the workflow then
# builds as a beta.
if [[ "$VERSION" == *-beta.* && "$BETA" == false ]]; then
    echo "Note: ${VERSION} is a prerelease — releasing into the beta channel."
    BETA=true
elif [[ "$VERSION" != *-beta.* && "$BETA" == true ]]; then
    echo "Error: --beta given, but ${VERSION} is not a beta version"
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Check clean working tree & run pre-flight tests ───────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: uncommitted changes present. Commit or stash first."
    git status --short
    exit 1
fi

echo "→ Running pre-flight checks (svelte-check, vitest & cargo test)..."
npm run check
npm --workspace server run check
npm test -- --run
( cd server && npx vitest run )
( cd src-tauri && cargo test )

if [[ "$BETA" == true ]]; then
    echo "→ Releasing v${VERSION} (beta channel)"
else
    echo "→ Releasing v${VERSION}"
fi

# ── Update version in all manifests ─────────────────────────────────────────
# Das Suffix muss mit ins Muster: steht in den Dateien schon eine Vorabversion,
# ersetzte ein Muster ohne Suffix nur den Zahlenteil und zurueck bliebe
# "0.8.0-beta.2-beta.1".
SEMVER='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?'
sed -i '' -E "s/\"version\": \"${SEMVER}\"/\"version\": \"${VERSION}\"/" package.json
echo "  ✓ package.json"
sed -i '' -E "s/\"version\": \"${SEMVER}\"/\"version\": \"${VERSION}\"/" server/package.json
echo "  ✓ server/package.json"
sed -i '' -E "s/\"version\": \"${SEMVER}\"/\"version\": \"${VERSION}\"/" src-tauri/tauri.conf.json
echo "  ✓ src-tauri/tauri.conf.json"
sed -i '' -E "s/^version = \"${SEMVER}\"/version = \"${VERSION}\"/" src-tauri/Cargo.toml
echo "  ✓ src-tauri/Cargo.toml"

# Keep Cargo.lock in sync with the new crate version.
( cd src-tauri && cargo update -p timetracker --precise "${VERSION}" >/dev/null 2>&1 || true )

# ── Verify all match ──────────────────────────────────────────────────────────
PKG=$(grep '"version"' package.json | head -1 | grep -Eo "${SEMVER}")
SERVER_PKG=$(grep '"version"' server/package.json | head -1 | grep -Eo "${SEMVER}")
TAURI=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | grep -Eo "${SEMVER}")
CARGO=$(grep '^version' src-tauri/Cargo.toml | head -1 | grep -Eo "${SEMVER}")

if [[ "$PKG" != "$VERSION" || "$SERVER_PKG" != "$VERSION" || "$TAURI" != "$VERSION" || "$CARGO" != "$VERSION" ]]; then
    echo "Error: version mismatch after update"
    echo "  package.json:        $PKG"
    echo "  server/package.json: $SERVER_PKG"
    echo "  tauri.conf.json:     $TAURI"
    echo "  Cargo.toml:          $CARGO"
    exit 1
fi

# ── Commit + tag + push ───────────────────────────────────────────────────────
git add package.json server/package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
if ! git diff --cached --quiet; then
    git commit -m "chore: release v${VERSION}"
fi

if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    echo "  Tag v${VERSION} existiert bereits lokal — wird überschrieben..."
    git tag -d "v${VERSION}"
fi

git tag "v${VERSION}"
git push origin HEAD
git push origin "v${VERSION}" --force

echo ""
echo "✓ Released v${VERSION} — CI build triggered."
if [[ "$BETA" == true ]]; then
    echo "  Beta channel: marked as prerelease, NSIS installer only."
    echo "  Testers need 'Vorabversionen (Beta)' switched on in the settings."
fi
echo "  https://github.com/joe2824/timetracker/releases"
