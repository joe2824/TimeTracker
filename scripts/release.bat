@echo off
REM Usage: scripts\release.bat [version]
REM Without version: auto-detects last release and prompts for patch/minor/major bump.
REM With version:    uses the given version directly.
REM Bumps version in package.json, tauri.conf.json, Cargo.toml, commits, tags and pushes.
REM Pushing the v* tag triggers .github/workflows/release.yml (build + GitHub release).
setlocal enabledelayedexpansion

set "VERSION=%~1"

REM Move to repo root early (needed for tag/manifest lookups).
cd /d "%~dp0.."

REM -- Auto-detect version if not provided -------------------------------------
if "%VERSION%"=="" (
  set "LAST_TAG="
  REM findstr's $ end-anchor misbehaves on piped output, so anchor only at the
  REM start; "^v<digit>" is specific enough and --sort gives the newest first.
  for /f "delims=" %%t in ('git tag --sort^=-v:refname ^| findstr /R "^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"') do (
    if not defined LAST_TAG set "LAST_TAG=%%t"
  )
  if defined LAST_TAG (
    set "LAST=!LAST_TAG:v=!"
  ) else (
    echo No version tags yet - using current package.json version as base.
    for /f "tokens=2 delims=:, " %%v in ('findstr /R /C:"\"version\"" package.json') do (
      if not defined LAST set "LAST=%%~v"
    )
  )

  for /f "tokens=1,2,3 delims=." %%a in ("!LAST!") do (
    set "MAJOR=%%a"
    set "MINOR=%%b"
    set "PATCH=%%c"
  )
  set /a NP=PATCH+1
  set /a NMI=MINOR+1
  set /a NMA=MAJOR+1
  set "NEXT_PATCH=!MAJOR!.!MINOR!.!NP!"
  set "NEXT_MINOR=!MAJOR!.!NMI!.0"
  set "NEXT_MAJOR=!NMA!.0.0"

  echo Last release: v!LAST!
  echo.
  echo   1^) patch -^> !NEXT_PATCH!  ^(bug fixes^)
  echo   2^) minor -^> !NEXT_MINOR!  ^(new features, backward-compatible^)
  echo   3^) major -^> !NEXT_MAJOR!  ^(breaking changes^)
  echo   4^) custom
  echo.
  set /p CHOICE=Bump type [1-4]:
  if "!CHOICE!"=="1" set "VERSION=!NEXT_PATCH!"
  if "!CHOICE!"=="2" set "VERSION=!NEXT_MINOR!"
  if "!CHOICE!"=="3" set "VERSION=!NEXT_MAJOR!"
  if "!CHOICE!"=="4" set /p VERSION=Version:
  if not defined VERSION (
    echo Invalid choice
    exit /b 1
  )
)

REM -- Validate ----------------------------------------------------------------
echo %VERSION%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo Error: version must be semver ^(e.g. 1.2.3^)
  exit /b 1
)

REM -- Refuse on a dirty working tree ------------------------------------------
for /f %%i in ('git status --porcelain') do (
  echo Error: uncommitted changes present. Commit or stash first.
  git status --short
  exit /b 1
)

echo -^> Releasing v%VERSION%

REM -- Update versions via PowerShell regex replace ----------------------------
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

REM -- Verify all match --------------------------------------------------------
set "PKG="
for /f "tokens=2 delims=:, " %%v in ('findstr /R /C:"\"version\"" package.json') do if not defined PKG set "PKG=%%~v"
set "TAURI="
for /f "tokens=2 delims=:, " %%v in ('findstr /R /C:"\"version\"" src-tauri\tauri.conf.json') do if not defined TAURI set "TAURI=%%~v"
set "CARGO="
for /f "tokens=2 delims== " %%v in ('findstr /R /C:"^version = " src-tauri\Cargo.toml') do if not defined CARGO set "CARGO=%%~v"

if not "%PKG%"=="%VERSION%" goto :mismatch
if not "%TAURI%"=="%VERSION%" goto :mismatch
if not "%CARGO%"=="%VERSION%" goto :mismatch

REM -- Commit + tag + push -----------------------------------------------------
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v%VERSION%"
git tag "v%VERSION%"
git push origin HEAD
git push origin "v%VERSION%"

echo.
echo Released v%VERSION% - CI build triggered.
echo   https://github.com/joe2824/timetracker/releases
endlocal
exit /b 0

:mismatch
echo Error: version mismatch after update
echo   package.json:    %PKG%
echo   tauri.conf.json: %TAURI%
echo   Cargo.toml:      %CARGO%
exit /b 1
