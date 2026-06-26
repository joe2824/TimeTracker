@echo off
REM Usage: scripts\release.bat [version]
REM Bumps version in package.json, tauri.conf.json, Cargo.toml, commits, tags and pushes.
REM Pushing the v* tag triggers .github/workflows/release.yml (build + GitHub release).
setlocal

set "VERSION=%~1"
if "%VERSION%"=="" set /p VERSION=Version (e.g. 1.2.3):

echo %VERSION%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo Error: version must be semver (e.g. 1.2.3)
  exit /b 1
)

cd /d "%~dp0.."

REM ── Refuse on a dirty working tree ──────────────────────────────────────────
for /f %%i in ('git status --porcelain') do (
  echo Error: uncommitted changes present. Commit or stash first.
  git status --short
  exit /b 1
)

echo -^> Releasing v%VERSION%

REM ── Update versions via PowerShell regex replace ────────────────────────────
powershell -NoProfile -Command "(Get-Content package.json -Raw) -replace '\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"', '\"version\": \"%VERSION%\"' | Set-Content -NoNewline package.json"
echo   ok package.json
powershell -NoProfile -Command "(Get-Content src-tauri/tauri.conf.json -Raw) -replace '\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"', '\"version\": \"%VERSION%\"' | Set-Content -NoNewline src-tauri/tauri.conf.json"
echo   ok tauri.conf.json
powershell -NoProfile -Command "(Get-Content src-tauri/Cargo.toml -Raw) -replace '(?m)^version = \"[0-9]+\.[0-9]+\.[0-9]+\"', 'version = \"%VERSION%\"' | Set-Content -NoNewline src-tauri/Cargo.toml"
echo   ok Cargo.toml

REM Keep Cargo.lock in sync with the new crate version.
pushd src-tauri
cargo update -p timetracker --precise %VERSION% >nul 2>&1
popd

REM ── Commit + tag + push ─────────────────────────────────────────────────────
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v%VERSION%"
git tag "v%VERSION%"
git push origin HEAD
git push origin "v%VERSION%"

echo.
echo Released v%VERSION% - CI build triggered.
echo   https://github.com/joe2824/timetracker/releases
endlocal
