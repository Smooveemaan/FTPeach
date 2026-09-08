param(
    [string]$ArchivePath,

    [string]$EnvironmentFile,

    [ValidateSet('prepare', 'dev', 'check', 'test', 'compatibility', 'clippy', 'cargo-build', 'build', 'smoke-build', 'verify-updater')]
    [string]$Command = 'build',

    [ValidateSet('debug', 'release')]
    [string]$Profile = 'debug'
)

$ErrorActionPreference = 'Stop'
$expectedSha256 = '3e03a726fac4bc09cb61d8f29d658ef7a5eca0811de59082130414f7ca2e4279'
$workspace = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $workspace '.tools\libsodium-1.0.22-msvc'

if (-not (Test-Path -LiteralPath $toolsRoot)) {
    if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
        throw "libsodium is not extracted. Pass -ArchivePath once to initialize .tools."
    }
    $archive = (Resolve-Path -LiteralPath $ArchivePath).Path
    $actualSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "Unexpected libsodium archive SHA-256: $actualSha256"
    }
    New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $toolsRoot -Force
}

# Use the optimized native library for every Rust profile. The prebuilt Debug
# archive is compiled with the debug CRT and without optimizations; besides
# producing LNK4098/LNK4099 warnings when linked into Rust, it makes
# Stronghold snapshot operations take tens of seconds. Rust itself remains a
# normal debug build for dev/check/test.
$configuration = 'Release'
$configurationPattern = "[\\/]$configuration[\\/]"
$library = Get-ChildItem -LiteralPath $toolsRoot -Recurse -Filter 'libsodium.lib' |
    Where-Object {
        $_.FullName -match '[\\/]x64[\\/]' -and
        $_.FullName -match $configurationPattern -and
        $_.FullName -match '[\\/]static[\\/]'
    } |
    Select-Object -First 1

if (-not $library) {
    throw "The verified archive does not contain an x64 $configuration static libsodium.lib."
}

# The upstream Debug archive embeds /DEFAULTLIB:LIBCMTD and is incompatible
# with Rust's MSVC CRT model. A byte-level check is deliberately used here so
# validation does not depend on dumpbin being present in PATH on CI runners.
$libraryBytes = [System.IO.File]::ReadAllBytes($library.FullName)
$libraryText = [System.Text.Encoding]::ASCII.GetString($libraryBytes)
if ($libraryText.Contains('LIBCMTD')) {
    throw "Selected libsodium.lib requires the debug static CRT (LIBCMTD)."
}

$symbols = Join-Path $library.Directory.FullName 'libsodium.pdb'
if (-not (Test-Path -LiteralPath $symbols -PathType Leaf)) {
    throw "The selected libsodium build has no matching libsodium.pdb."
}

# libsodium owns all allocations returned by sodium_malloc: callers release
# them with sodium_free instead of a Rust/C allocator. This keeps allocation
# and deallocation on the same side of the native CRT boundary.

# libsodium-sys-stable checks this variable before attempting any download.
# Keeping it process-local avoids machine-specific paths in Cargo config.
$env:SODIUM_LIB_DIR = $library.Directory.FullName
$previousCargoTargetDir = $env:CARGO_TARGET_DIR

# GitHub Actions launches the release builder in a later process. Persist only
# the verified library directory when the workflow explicitly supplies its
# environment file; local invocations keep the variable process-scoped.
if (-not [string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    $environmentLine = "SODIUM_LIB_DIR=$($library.Directory.FullName)$([Environment]::NewLine)"
    [System.IO.File]::AppendAllText(
        $EnvironmentFile,
        $environmentLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

# WiX 3 light.exe fails while finishing its CAB when the MSI output path
# contains Cyrillic characters. Keep release artifacts in a stable ASCII path;
# source files and the project itself may remain in their original directory.
if ($Command -eq 'build') {
    $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'FTPeachBuild\target'
}
elseif ($Command -eq 'smoke-build') {
    $env:CARGO_TARGET_DIR = Join-Path $workspace '.tools\smoke-target'
}

# Object records in the upstream archive refer to libsodium.pdb by basename.
# Put the matching symbols in both possible linker output directories before
# Cargo starts; /WX:4099 then reliably detects a missing or mismatched PDB.
$targetRoot = if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    Join-Path $workspace 'src-tauri\target'
}
else {
    $env:CARGO_TARGET_DIR
}
foreach ($cargoProfile in @('debug', 'release')) {
    $dependencyDirectory = Join-Path $targetRoot "$cargoProfile\deps"
    New-Item -ItemType Directory -Path $dependencyDirectory -Force | Out-Null
    Copy-Item -LiteralPath $symbols -Destination (Join-Path $dependencyDirectory 'libsodium.pdb') -Force
}

Push-Location $workspace
try {
    switch ($Command) {
        'prepare' {
            $LASTEXITCODE = 0
        }
        'dev' {
            & npm.cmd run dev:tauri
        }
        'check' {
            & cargo check --locked --manifest-path 'src-tauri\Cargo.toml'
        }
        'test' {
            & cargo test --locked --manifest-path 'src-tauri\Cargo.toml' --all-targets
        }
        'compatibility' {
            & cargo test --locked --manifest-path 'src-tauri\Cargo.toml' --features test-utils --test docker_integration -- --ignored
        }
        'clippy' {
            & cargo clippy --locked --manifest-path 'src-tauri\Cargo.toml' --all-targets --all-features -- -D warnings
        }
        'cargo-build' {
            $cargoArguments = @('build', '--locked', '--manifest-path', 'src-tauri\Cargo.toml')
            if ($Profile -eq 'release') {
                $cargoArguments += '--release'
            }
            & cargo @cargoArguments
        }
        'build' {
            & npm.cmd run build:tauri:raw
        }
        'smoke-build' {
            & npm.cmd run build
            if ($LASTEXITCODE -eq 0) {
                & npx.cmd tauri build --debug --no-bundle --features smoke-test
            }
        }
        'verify-updater' {
            $publicKey = (Get-Content -Raw 'test\fixtures\updater\spike.key.pub').Trim()
            $artifact = 'test\fixtures\updater\dummy-update.bin'
            $signature = 'test\fixtures\updater\dummy-update.bin.sig'
            & cargo run --locked --manifest-path 'src-tauri\Cargo.toml' --example verify_updater -- $publicKey $artifact $signature
            if ($LASTEXITCODE -ne 0) {
                throw 'Valid updater fixture failed signature verification.'
            }

            $damagedArtifact = Join-Path ([System.IO.Path]::GetTempPath()) "ftpeach-damaged-update-$PID.bin"
            try {
                Copy-Item -LiteralPath $artifact -Destination $damagedArtifact -Force
                [System.IO.File]::AppendAllText($damagedArtifact, 'damaged')
                & cargo run --locked --manifest-path 'src-tauri\Cargo.toml' --example verify_updater -- $publicKey $damagedArtifact $signature
                if ($LASTEXITCODE -eq 0) {
                    throw 'Damaged updater artifact unexpectedly passed signature verification.'
                }
                Write-Host 'Updater fixtures OK: valid artifact accepted; damaged artifact rejected.'
                $LASTEXITCODE = 0
            }
            finally {
                Remove-Item -LiteralPath $damagedArtifact -Force -ErrorAction SilentlyContinue
            }
        }
    }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
    Remove-Item Env:SODIUM_LIB_DIR -ErrorAction SilentlyContinue
    if ($null -eq $previousCargoTargetDir) {
        Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:CARGO_TARGET_DIR = $previousCargoTargetDir
    }
}
