#!/bin/bash
# Usage: ./scripts/release.sh [version]
# Without version: auto-detects last release and prompts for patch/minor/major bump.
# With version:    uses the given version directly.
# Bumps version in package.json, tauri.conf.json, Cargo.toml, commits, tags and pushes.
# The push of the v* tag triggers .github/workflows/release.yml (build + GitHub release).

set -euo pipefail

VERSION="${1:-}"

# ── Auto-detect version if not provided ──────────────────────────────────────
if [[ -z "$VERSION" ]]; then
    LAST_TAG=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    if [[ -z "$LAST_TAG" ]]; then
        echo "No version tags yet — using current package.json version as base."
        LAST="$(grep '"version"' package.json | head -1 | grep -o '[0-9]*\.[0-9]*\.[0-9]*')"
    else
        LAST="${LAST_TAG#v}"
    fi
    MAJOR=$(echo "$LAST" | cut -d. -f1)
    MINOR=$(echo "$LAST" | cut -d. -f2)
    PATCH=$(echo "$LAST" | cut -d. -f3)

    NEXT_PATCH="${MAJOR}.${MINOR}.$((PATCH + 1))"
    NEXT_MINOR="${MAJOR}.$((MINOR + 1)).0"
    NEXT_MAJOR="$((MAJOR + 1)).0.0"

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

# ── Validate ──────────────────────────────────────────────────────────────────
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version must be semver (e.g. 1.2.3)"
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Check clean working tree ──────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
    echo "Error: uncommitted changes present. Commit or stash first."
    git status --short
    exit 1
fi

echo "→ Releasing v${VERSION}"

# ── Update version in all three manifests ────────────────────────────────────
sed -i '' "s/\"version\": \"[0-9]*\.[0-9]*\.[0-9]*\"/\"version\": \"${VERSION}\"/" package.json
echo "  ✓ package.json"
sed -i '' "s/\"version\": \"[0-9]*\.[0-9]*\.[0-9]*\"/\"version\": \"${VERSION}\"/" src-tauri/tauri.conf.json
echo "  ✓ src-tauri/tauri.conf.json"
sed -i '' "s/^version = \"[0-9]*\.[0-9]*\.[0-9]*\"/version = \"${VERSION}\"/" src-tauri/Cargo.toml
echo "  ✓ src-tauri/Cargo.toml"

# Keep Cargo.lock in sync with the new crate version.
( cd src-tauri && cargo update -p timetracker --precise "${VERSION}" >/dev/null 2>&1 || true )

# ── Verify all match ──────────────────────────────────────────────────────────
PKG=$(grep '"version"' package.json | head -1 | grep -o '[0-9]*\.[0-9]*\.[0-9]*')
TAURI=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | grep -o '[0-9]*\.[0-9]*\.[0-9]*')
CARGO=$(grep '^version' src-tauri/Cargo.toml | head -1 | grep -o '[0-9]*\.[0-9]*\.[0-9]*')

if [[ "$PKG" != "$VERSION" || "$TAURI" != "$VERSION" || "$CARGO" != "$VERSION" ]]; then
    echo "Error: version mismatch after update"
    echo "  package.json:    $PKG"
    echo "  tauri.conf.json: $TAURI"
    echo "  Cargo.toml:      $CARGO"
    exit 1
fi

# ── Commit + tag + push ───────────────────────────────────────────────────────
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"
git push origin HEAD
git push origin "v${VERSION}"

echo ""
echo "✓ Released v${VERSION} — CI build triggered."
echo "  https://github.com/joe2824/timetracker/releases"
