@echo off
REM Usage: scripts\release.bat [--beta] [version]
REM Without version: auto-detects last release and prompts for patch/minor/major bump.
REM With version:    uses the given version directly (1.2.3 or 1.2.3-beta.1).
REM With --beta:     releases into the beta channel (prerelease, NSIS only).
REM Bumps version in package.json, tauri.conf.json, Cargo.toml, commits, tags and pushes.
REM Pushing the v* tag triggers .github/workflows/release.yml (build + GitHub release).
setlocal enabledelayedexpansion

set "BETA=0"
set "VERSION=%~1"
if /I "%VERSION%"=="--beta" (
  set "BETA=1"
  set "VERSION=%~2"
)

REM Move to repo root early (needed for tag/manifest lookups).
cd /d "%~dp0.."

REM -- Auto-detect version if not provided -------------------------------------
if "%VERSION%"=="" (
  set "LAST_TAG="
  REM findstr's $ end-anchor misbehaves on piped output, so anchor only at the
  REM start; "^v<digit>" is specific enough and --sort gives the newest first.
  REM Vorabversionen muessen dabei raus: ohne End-Anker passt "v0.8.0-beta.1" auf
  REM dasselbe Muster, und aus "0-beta" wuerde beim Hochzaehlen des Patch-Stands
  REM Unsinn.
  for /f "delims=" %%t in ('git tag --sort^=-v:refname ^| findstr /R "^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" ^| findstr /V /C:"-beta."') do (
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

  REM -- Beta: eine offene Serie fortzaehlen, sonst neu bei -beta.1 anfangen ----
  REM Offen heisst: es gibt eine Beta, deren Basisversion ueber der letzten
  REM stabilen liegt. Wieder bei -beta.1 anzufangen ergaebe eine Version, die
  REM AELTER ist als das, was die Tester schon laufen haben - der Updater boete
  REM sie nie an. Der Vergleich laeuft in PowerShell, [version] kann Semver.
  set "SERIES="
  if "!BETA!"=="1" (
    set "LAST_BETA="
    for /f "delims=" %%t in ('git tag --sort^=-v:refname ^| findstr /R "^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-beta\.[0-9][0-9]*"') do (
      if not defined LAST_BETA set "LAST_BETA=%%t"
    )
    if defined LAST_BETA (
      for /f "tokens=1,2 delims=-" %%a in ("!LAST_BETA:~1!") do (
        set "BETA_BASE=%%a"
        set "BETA_COUNT=%%b"
      )
      set "BETA_COUNT=!BETA_COUNT:beta.=!"
      REM Kein Ternary: Windows PowerShell 5.1 kennt ihn nicht, erst 7 tut es.
      powershell -NoProfile -Command "if ([version]'!BETA_BASE!' -gt [version]'!LAST!') { exit 0 } else { exit 1 }"
      if not errorlevel 1 (
        set /a NEXT_COUNT=BETA_COUNT+1
        set "SERIES=!BETA_BASE!-beta.!NEXT_COUNT!"
      )
    )
  )

  if defined SERIES (
    echo Running beta series: !LAST_BETA:~1! -^> !SERIES!
    set "VERSION=!SERIES!"
  ) else (
    set "SUFFIX="
    if "!BETA!"=="1" set "SUFFIX=-beta.1"
    if "!BETA!"=="1" (
      echo Last release: v!LAST! ^(no open beta series^)
    ) else (
      echo Last release: v!LAST!
    )
    echo.
    echo   1^) patch -^> !NEXT_PATCH!!SUFFIX!  ^(bug fixes^)
    echo   2^) minor -^> !NEXT_MINOR!!SUFFIX!  ^(new features, backward-compatible^)
    echo   3^) major -^> !NEXT_MAJOR!!SUFFIX!  ^(breaking changes^)
    echo   4^) custom
    echo.
    set /p CHOICE=Bump type [1-4]:
    if "!CHOICE!"=="1" set "VERSION=!NEXT_PATCH!!SUFFIX!"
    if "!CHOICE!"=="2" set "VERSION=!NEXT_MINOR!!SUFFIX!"
    if "!CHOICE!"=="3" set "VERSION=!NEXT_MAJOR!!SUFFIX!"
    if "!CHOICE!"=="4" set /p VERSION=Version:
    if not defined VERSION (
      echo Invalid choice
      exit /b 1
    )
  )
)

REM -- Validate ----------------------------------------------------------------
echo %VERSION%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$ ^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-beta\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo Error: version must be semver ^(e.g. 1.2.3^) or a beta ^(e.g. 1.2.3-beta.1^)
  exit /b 1
)

REM -- Kanal und Version muessen zusammenpassen --------------------------------
echo %VERSION%| findstr /R "beta" >nul
if errorlevel 1 (
  if "%BETA%"=="1" (
    echo Error: --beta given, but %VERSION% is not a beta version
    exit /b 1
  )
) else (
  if not "%BETA%"=="1" (
    echo Note: %VERSION% is a prerelease - releasing into the beta channel.
    set "BETA=1"
  )
)

REM -- Refuse on a dirty working tree ------------------------------------------
for /f %%i in ('git status --porcelain') do (
  echo Error: uncommitted changes present. Commit or stash first.
  git status --short
  exit /b 1
)

echo -^> Running pre-flight checks (svelte-check ^& test suites)...
call npm run check || exit /b 1
call npm --workspace server run check || exit /b 1
call npm test -- --run || exit /b 1

if "%BETA%"=="1" (
  echo -^> Releasing v%VERSION% ^(beta channel^)
) else (
  echo -^> Releasing v%VERSION%
)

REM -- Update versions via PowerShell regex replace ----------------------------
powershell -NoProfile -Command "(Get-Content package.json -Raw) -replace '\"version\": \"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\"', '\"version\": \"%VERSION%\"' | Set-Content -NoNewline package.json"
echo   ok package.json
powershell -NoProfile -Command "(Get-Content server/package.json -Raw) -replace '\"version\": \"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\"', '\"version\": \"%VERSION%\"' | Set-Content -NoNewline server/package.json"
echo   ok server/package.json
powershell -NoProfile -Command "(Get-Content src-tauri/tauri.conf.json -Raw) -replace '\"version\": \"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\"', '\"version\": \"%VERSION%\"' | Set-Content -NoNewline src-tauri/tauri.conf.json"
echo   ok tauri.conf.json
powershell -NoProfile -Command "(Get-Content src-tauri/Cargo.toml -Raw) -replace '(?m)^version = \"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?\"', 'version = \"%VERSION%\"' | Set-Content -NoNewline src-tauri/Cargo.toml"
echo   ok Cargo.toml

REM Keep Cargo.lock in sync with the new crate version.
pushd src-tauri
cargo update -p timetracker --precise %VERSION% >nul 2>&1
popd

REM -- Verify all match --------------------------------------------------------
set "PKG="
for /f "tokens=2 delims=:, " %%v in ('findstr /R /C:"\"version\"" package.json') do if not defined PKG set "PKG=%%~v"
set "SERVER_PKG="
for /f "tokens=2 delims=:, " %%v in ('findstr /R /C:"\"version\"" server\package.json') do if not defined SERVER_PKG set "SERVER_PKG=%%~v"
set "TAURI="
for /f "tokens=2 delims=:, " %%v in ('findstr /R /C:"\"version\"" src-tauri\tauri.conf.json') do if not defined TAURI set "TAURI=%%~v"
set "CARGO="
for /f "tokens=2 delims== " %%v in ('findstr /R /C:"^version = " src-tauri\Cargo.toml') do if not defined CARGO set "CARGO=%%~v"

if not "%PKG%"=="%VERSION%" goto :mismatch
if not "%SERVER_PKG%"=="%VERSION%" goto :mismatch
if not "%TAURI%"=="%VERSION%" goto :mismatch
if not "%CARGO%"=="%VERSION%" goto :mismatch

REM -- Commit + tag + push -----------------------------------------------------
git add package.json server/package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git diff --cached --quiet || git commit -m "chore: release v%VERSION%"
git tag -d "v%VERSION%" >nul 2>&1
git tag "v%VERSION%"
git push origin HEAD
git push origin "v%VERSION%" --force

echo.
echo Released v%VERSION% - CI build triggered.
if "%BETA%"=="1" (
  echo   Beta channel: marked as prerelease, NSIS installer only.
  echo   Testers need "Vorabversionen ^(Beta^)" switched on in the settings.
)
echo   https://github.com/joe2824/timetracker/releases
endlocal
exit /b 0

:mismatch
echo Error: version mismatch after update
echo   package.json:    %PKG%
echo   tauri.conf.json: %TAURI%
echo   Cargo.toml:      %CARGO%
exit /b 1
